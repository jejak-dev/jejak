import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import {
  cachedClaude,
  defaultExists,
  defaultRunVersion,
  invalidateClaudeCache,
  locateClaude,
  nextClaudeCacheKey,
  readClaudeSetting,
  validateClaudePath,
  writeClaudeSetting,
  type ClaudeSource,
  type LocateOptions,
} from "../sdk/claude-locator";
import {
  downloadTarball,
  fetchPackument,
  pickVersion,
  RegistryError,
  SDK_SUPPORTED_RANGE,
  type FetchLike,
} from "../sdk/registry";
import {
  SDK_PACKAGE_NAME,
  SdkStoreError,
  getStatus,
  installFromTarball,
  isInstallBusy,
  rollback,
  sdkRoot,
  withInstallLock,
} from "../sdk/sdk-store";
import { TarballError } from "../sdk/tarball";

/**
 * Rute pengelolaan SDK yang dipasang pengguna.
 *
 * Semua rute di bawah `/api/sdk` dan sudah berada di belakang penjaga
 * Host/Origin serta autentikasi yang dipasang di `createApp`.
 */

export interface SdkRoutesOptions {
  /** Folder penyimpanan SDK; default `<jejakHome(env)>/sdk`. */
  root?: string;
  env?: Record<string, string | undefined>;
  /** `fetch` pengganti untuk pengujian; bawaannya `fetch` global. */
  fetch?: FetchLike;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
  /** Waktu ISO-8601 sekarang; untuk pengujian. */
  now?: () => string;
  /** Opsi pencarian CLI `claude`; untuk pengujian agar tak menjalankan claude sungguhan. */
  locate?: LocateOptions;
}

interface LastCheck {
  latest: string | null;
  checkedAt: string;
  note?: string;
}

/** Status CLI `claude` milik pengguna yang dilaporkan ke klien. */
export interface SdkClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  source: ClaudeSource | null;
  configuredPath: string | null;
}

const INSTALL_BODY_FIELDS = new Set(["version"]);
const CLAUDE_PATH_BODY_FIELDS = new Set(["path"]);

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Galat permintaan ringan; dipetakan ke 400. */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

function parseJsonObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "string" || body.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BadRequestError("Body permintaan harus berupa JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError("Body permintaan harus berupa objek.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Body installing: hanya field `version` yang diterima.
 *
 * Field lain ditolak outright supaya klien tidak bisa smuggle parameter
 * tak terduga ke lapisan registry.
 */
function parseInstallBody(body: unknown): { version?: string } {
  const parsed = parseJsonObject(body);
  for (const key of Object.keys(parsed)) {
    if (!INSTALL_BODY_FIELDS.has(key)) {
      throw new BadRequestError(`Field "${key}" tidak dikenal pada permintaan ini.`);
    }
  }
  const raw = parsed["version"];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") {
    throw new BadRequestError("Field version harus berupa string.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  if (trimmed !== "latest" && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)*$/.test(trimmed)) {
    throw new BadRequestError(`Versi "${trimmed}" bukan semver yang valid.`);
  }
  return { version: trimmed };
}

/**
 * Body pengaturan jalur CLI: hanya field `path` yang diterima.
 *
 * `path` kosong atau `null` berarti hapus pengaturan; string lain harus
 * lolos pemeriksaan jalur.
 */
function parseClaudePathBody(body: unknown): { path: string | null } {
  const parsed = parseJsonObject(body);
  for (const key of Object.keys(parsed)) {
    if (!CLAUDE_PATH_BODY_FIELDS.has(key)) {
      throw new BadRequestError(`Field "${key}" tidak dikenal pada permintaan ini.`);
    }
  }
  const raw = parsed["path"];
  if (raw === undefined || raw === null) return { path: null };
  if (typeof raw !== "string") {
    throw new BadRequestError("Field path harus berupa string.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { path: null };
  return { path: trimmed };
}

/** Pesan galat yang jelas untuk tiap alasan penolakan jalur. */
function claudePathMessage(reason: string): string {
  if (reason === "bukan-absolut") return "Jalur harus absolut.";
  if (reason === "karakter-kontrol") {
    return "Jalur tidak valid: karakter kontrol tidak diizinkan.";
  }
  if (reason === "terlalu-panjang") return "Jalur terlalu panjang.";
  return "Jalur harus berupa teks.";
}

/** Kode singkat untuk audit; bukan pesan galat. */
function errorCode(error: unknown): string {
  if (error instanceof RegistryError) return error.code;
  if (error instanceof TarballError) return error.code;
  if (error instanceof SdkStoreError) return error.code;
  if (error instanceof BadRequestError) return "invalid";
  return "lainnya";
}

/** Pemetaan galat ke status HTTP; tanpa jejak tumpukan atau jalur internal. */
function errorResponse(error: unknown): Response {
  if (error instanceof BadRequestError) {
    return jsonResponse(400, { error: error.message });
  }
  if (error instanceof RegistryError) {
    switch (error.code) {
      case "invalid":
      case "out-of-range":
        return jsonResponse(400, { error: error.message });
      case "not-found":
        return jsonResponse(404, { error: error.message });
      case "timeout":
        return jsonResponse(502, {
          error: "Registry npm tidak merespons tepat waktu. Coba lagi nanti.",
        });
      case "redirect":
        return jsonResponse(502, {
          error: "Registry npm mengalihkan permintaan ke alamat lain; pengalihan ditolak.",
        });
      case "too-large":
        return jsonResponse(502, {
          error: "Ukuran unduhan melebihi batas yang diizinkan.",
        });
      case "bad-response":
        return jsonResponse(502, {
          error: "Metadata registry npm tidak dapat dibaca.",
        });
      default:
        return jsonResponse(502, {
          error: "Tidak bisa menghubungi registry npm. Periksa koneksi internet.",
        });
    }
  }
  if (error instanceof TarballError) {
    if (error.code === "integrity") {
      return jsonResponse(422, {
        error:
          "Integritas tarball tidak cocok dengan metadata registry. Unduhan ditolak dan tidak ada SDK yang dipasang.",
      });
    }
    return jsonResponse(422, {
      error:
        "Isi paket SDK tidak aman atau tidak lengkap. Unduhan ditolak dan tidak ada SDK yang dipasang.",
    });
  }
  if (error instanceof SdkStoreError) {
    if (error.code === "busy") {
      return jsonResponse(409, {
        error: "Pemasangan SDK sedang berjalan. Coba lagi sebentar lagi.",
      });
    }
    if (error.code === "no-previous") {
      return jsonResponse(404, {
        error: "Tidak ada versi SDK sebelumnya untuk dikembalikan.",
      });
    }
    if (error.code === "not-found") {
      return jsonResponse(404, { error: "SDK yang diminta tidak ditemukan." });
    }
    return jsonResponse(400, { error: "Permintaan tidak valid." });
  }
  return jsonResponse(500, { error: "Terjadi kesalahan tak terduga." });
}

export function sdkRoutes(options: SdkRoutesOptions = {}): Elysia {
  const env = options.env ?? process.env;
  const root = options.root ?? sdkRoot(env);
  const audit = options.audit;
  const now = options.now ?? ((): string => new Date().toISOString());
  const fetchImpl = options.fetch;

  // Opsi pencarian CLI `claude`; dapat diinjeksi agar tes tak menjalankan claude sungguhan.
  const locateOptions: LocateOptions = {
    ...(options.locate ?? {}),
    env: options.locate?.env ?? env,
  };
  const existsImpl = locateOptions.exists ?? defaultExists;
  const runVersionImpl = locateOptions.runVersion ?? defaultRunVersion;
  const timeoutMs = locateOptions.timeoutMs ?? 5000;
  const claudeCacheKey = nextClaudeCacheKey("route");

  /** Status CLI `claude`; sumber dan jalur hasil pencarian. */
  const claudeStatus = async (): Promise<SdkClaudeStatus> => {
    const location = await cachedClaude(
      claudeCacheKey,
      () => locateClaude(locateOptions),
    );
    const configured = await readClaudeSetting(locateOptions.env ?? env);
    return {
      found: location !== null,
      path: location?.path ?? null,
      version: location?.version ?? null,
      source: location?.source ?? null,
      configuredPath: configured,
    };
  };

  // Hasil pemeriksaan terakhir; cukup disimpan di memori proses.
  let lastCheck: LastCheck | null = null;

  const plugin = new Elysia({ name: "jejak-sdk-routes" })
    .get("/api/sdk", async () => {
      try {
        const status = await getStatus(root);
        return {
          installed:
            status.installed === null
              ? null
              : {
                  version: status.installed.version,
                  installedAt: status.installed.installedAt,
                },
          previous: status.previous,
          supportedRange: SDK_SUPPORTED_RANGE,
          lastCheck,
          busy: isInstallBusy(),
          claude: await claudeStatus(),
        };
      } catch {
        return jsonResponse(500, { error: "Terjadi kesalahan tak terduga." });
      }
    })
    .post(
      "/api/sdk/claude-path",
      async ({ body }) => {
        let requested: string | null;
        try {
          requested = parseClaudePathBody(body).path;
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Pengaturan jalur claude gagal",
            meta: { aksi: "claude-jalur", ok: false, hasil: "gagal", galat: errorCode(error) },
          });
          return errorResponse(error);
        }

        try {
          if (requested !== null) {
            const check = validateClaudePath(requested);
            if (!check.ok) throw new BadRequestError(claudePathMessage(check.reason));
            if (!(await existsImpl(requested))) {
              throw new BadRequestError("Berkas tidak ditemukan.");
            }
            const version = await runVersionImpl(requested, timeoutMs);
            if (version === null) {
              throw new BadRequestError("Berkas tidak menjawab --version.");
            }
          }

          await writeClaudeSetting(requested, locateOptions.env ?? env);
          invalidateClaudeCache();

          recordAudit(audit, {
            kind: "pengaturan",
            summary:
              requested === null
                ? "Pengaturan jalur claude dihapus"
                : "Pengaturan jalur claude disimpan",
            // Jalur penuh tidak pernah masuk audit.
            meta: {
              aksi: "claude-jalur",
              ok: true,
              hasil: requested === null ? "hapus" : "simpan",
            },
          });
          return await claudeStatus();
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Pengaturan jalur claude gagal",
            meta: { aksi: "claude-jalur", ok: false, hasil: "gagal", galat: errorCode(error) },
          });
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sdk/check",
      async () => {
        try {
          const packument = await fetchPackument(
            fetchImpl === undefined ? {} : { fetch: fetchImpl },
          );
          const picked = pickVersion({ versions: packument.versions, latest: packument.latest });
          lastCheck = {
            latest: packument.latest,
            checkedAt: now(),
            ...(picked.note === undefined ? {} : { note: picked.note }),
          };
          const status = await getStatus(root);
          const installedVersion = status.installed?.version ?? null;
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Versi SDK diperiksa",
            meta: {
              aksi: "sdk-periksa",
              versi: picked.version,
              ok: true,
            },
          });
          return {
            latest: packument.latest,
            candidate: picked.version,
            ...(picked.note === undefined ? {} : { note: picked.note }),
            // Perkiraan ukuran terpasang; UI memakai ini sebelum persetujuan.
            ...(picked.unpackedSize === undefined ? {} : { unpackedSize: picked.unpackedSize }),
            installedVersion,
            updateAvailable:
              installedVersion !== null && installedVersion !== picked.version,
          };
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Pemeriksaan versi SDK gagal",
            meta: { aksi: "sdk-periksa", ok: false, galat: errorCode(error) },
          });
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sdk/install",
      async ({ body }) => {
        let requested: string | undefined;
        try {
          requested = parseInstallBody(body).version;
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Pemasangan SDK gagal",
            meta: { aksi: "sdk-pasang", ok: false, galat: errorCode(error), integritas: false },
          });
          return errorResponse(error);
        }

        try {
          const result = await withInstallLock(async () => {
            const packument = await fetchPackument(
              fetchImpl === undefined ? {} : { fetch: fetchImpl },
            );
            const picked = pickVersion({
              versions: packument.versions,
              latest: packument.latest,
              ...(requested === undefined ? {} : { requested }),
            });
            const entry = packument.versions[picked.version];
            const { gz } = await downloadTarball(picked.version, {
              ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
              ...(entry === undefined ? {} : { expectedTarball: entry.tarball }),
            });
            const installed = await installFromTarball(root, {
              gz,
              integrity: picked.integrity,
              expected: { name: SDK_PACKAGE_NAME, version: picked.version },
              now: now(),
            });
            return { installed, note: picked.note };
          });

          recordAudit(audit, {
            kind: "pengaturan",
            summary: "SDK dipasang",
            meta: {
              aksi: "sdk-pasang",
              versi: result.installed.version,
              ok: true,
              integritas: true,
            },
          });
          return {
            installed: {
              version: result.installed.version,
              installedAt: result.installed.installedAt,
            },
            ...(result.note === undefined ? {} : { note: result.note }),
          };
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Pemasangan SDK gagal",
            meta: {
              aksi: "sdk-pasang",
              versi: requested ?? "terbaru",
              ok: false,
              galat: errorCode(error),
              integritas: false,
            },
          });
          return errorResponse(error);
        }
      },
      { parse: "text" },
    )
    .post(
      "/api/sdk/rollback",
      async () => {
        try {
          const result = await rollback(root);
          const status = await getStatus(root);
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "SDK dikembalikan ke versi sebelumnya",
            meta: { aksi: "sdk-rollback", versi: result.version, ok: true },
          });
          return {
            installed:
              status.installed === null
                ? null
                : {
                    version: status.installed.version,
                    installedAt: status.installed.installedAt,
                  },
          };
        } catch (error) {
          recordAudit(audit, {
            kind: "pengaturan",
            summary: "Rollback SDK gagal",
            meta: {
              aksi: "sdk-rollback",
              ok: false,
              galat: errorCode(error),
            },
          });
          return errorResponse(error);
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
