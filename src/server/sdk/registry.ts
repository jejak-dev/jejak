import { SDK_PACKAGE_NAME, isValidSdkVersion } from "./sdk-store";

/**
 * Klien registry npm untuk SDK.
 *
 * Sumber bersifat tetap: hanya `https://registry.npmjs.org` dan paket
 * `@anthropic-ai/claude-agent-sdk`. Klien HTTP tidak pernah boleh
 * menentukan URL; parameter `fetch` hanya disuntik untuk pengujian.
 */

export const REGISTRY_ORIGIN = "https://registry.npmjs.org";

/** Rentang versi SDK yang sudah diuji dan didukung Jejak. */
export const SDK_SUPPORTED_RANGE = ">=0.3.0 <1";

const PACKAGE_SCOPE = SDK_PACKAGE_NAME.slice(0, SDK_PACKAGE_NAME.indexOf("/"));
const PACKAGE_BASENAME = SDK_PACKAGE_NAME.slice(SDK_PACKAGE_NAME.indexOf("/") + 1);

/** Alamat metadata paket; nama cakupan disandikan seperti bentuk npm. */
export const PACKUMENT_URL = `${REGISTRY_ORIGIN}/${PACKAGE_SCOPE}%2F${PACKAGE_BASENAME}`;

const PACKUMENT_TIMEOUT_MS = 20_000;
const PACKUMENT_MAX_BYTES = 10 * 1024 * 1024;
const TARBALL_TIMEOUT_MS = 120_000;
const TARBALL_MAX_BYTES = 20 * 1024 * 1024;

export type FetchLike = typeof fetch;

export type RegistryErrorCode =
  | "network"
  | "bad-response"
  | "too-large"
  | "redirect"
  | "timeout"
  | "not-found"
  | "out-of-range"
  | "invalid";

/** Galat stabil pada kode supaya rute bisa memetakan status HTTP. */
export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: RegistryErrorCode,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface PackumentVersion {
  version: string;
  /** Nilai SRI sha512 dari metadata registry. */
  integrity: string;
  /** Alamat tarball dari metadata; hanya dibandingkan, bukan dipakai mengunduh. */
  tarball: string;
  /** Ukuran isi paket setelah diekstrak, bila registry menyodorkannya. */
  unpackedSize?: number;
}

export interface Packument {
  /** Versi dari `dist-tags.latest`; null bila tidak ada. */
  latest: string | null;
  versions: Record<string, PackumentVersion>;
}

export interface PickedVersion {
  version: string;
  /** Catatan Bahasa Indonesia bila pilihan tidak sama dengan `latest`. */
  note?: string;
  integrity: string;
  unpackedSize?: number;
}

/* ------------------------------------------------------------------ helper */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrerelease(version: string): boolean {
  return version.includes("-");
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isWithinRange(version: string): boolean {
  try {
    return Bun.semver.satisfies(version, SDK_SUPPORTED_RANGE);
  } catch {
    return false;
  }
}

/** Hanya https ke host registry npm yang dipercaya. */
function isTrustedRegistryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "registry.npmjs.org" &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

/** URL tarball dibangun sendiri dari pola tetap; bukan dari metadata. */
export function buildTarballUrl(version: string): string {
  return `${REGISTRY_ORIGIN}/${PACKAGE_SCOPE}/${PACKAGE_BASENAME}/-/${PACKAGE_BASENAME}-${version}.tgz`;
}

/* ------------------------------------------------------------- pengambilan */

/**
 * Membaca body secara bertahap dengan batas ukuran.
 *
 * Saat batas terlampaui, stream dibatalkan supaya unduhan tidak terus
 * berjalan di belakang layar.
 */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new RegistryError("Ukuran respons registry melebihi batas.", "too-large");
    }
    return new Uint8Array(buffer);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("melebihi batas ukuran");
        } catch {
          // Stream mungkin sudah tertutup; galat batas yang penting.
        }
        throw new RegistryError("Ukuran respons registry melebihi batas.", "too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Melakukan permintaan dengan batas waktu dan ukuran.
 *
 * Sinyal `AbortSignal.timeout` dipakai untuk membatalkan permintaan yang
 * benar-benar berjalan; balapan dengan pengatur waktu tambahan memastikan
 * galat waktu habis tetap muncul walau `fetch` palsu mengabaikan sinyal.
 */
async function fetchLimited(
  url: string,
  init: RequestInit,
  limits: { fetchImpl: FetchLike; timeoutMs: number; maxBytes: number },
): Promise<Uint8Array> {
  const timeoutSignal = AbortSignal.timeout(limits.timeoutMs);
  const signal =
    init.signal === undefined || init.signal === null
      ? timeoutSignal
      : AbortSignal.any([timeoutSignal, init.signal]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RegistryError("Registry npm tidak merespons tepat waktu.", "timeout"));
    }, limits.timeoutMs);
  });

  try {
    let response: Response;
    try {
      response = await Promise.race([
        limits.fetchImpl(url, { ...init, signal }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      if (isAbortError(error)) {
        throw new RegistryError("Registry npm tidak merespons tepat waktu.", "timeout");
      }
      throw new RegistryError("Gagal menghubungi registry npm.", "network");
    }

    if (response.status >= 300 && response.status < 400) {
      throw new RegistryError(
        "Registry npm mengalihkan permintaan ke alamat lain; pengalihan ditolak.",
        "redirect",
      );
    }
    if (response.status === 404) {
      throw new RegistryError("Paket tidak ditemukan di registry npm.", "not-found");
    }
    if (response.status !== 200) {
      throw new RegistryError("Registry npm menjawab dengan status tak terduga.", "bad-response");
    }

    return await readLimited(response, limits.maxBytes);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* --------------------------------------------------------------- packument */

/**
 * Mengambil metadata paket dari registry npm.
 *
 * Hanya `dist-tags` dan sebagian kecil `versions[*].dist` yang dipakai;
 * tidak ada cookie, identitas, atau token yang dikirim.
 *
 * `timeoutMs` hanya dipakai pengujian; nilai bawaannya tetap 20 detik.
 */
export async function fetchPackument(
  options: { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Packument> {
  const fetchImpl = options.fetch ?? fetch;
  const bytes = await fetchLimited(
    PACKUMENT_URL,
    {
      method: "GET",
      headers: { accept: "application/vnd.npm.install-v1+json" },
      credentials: "omit",
      redirect: "manual",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    {
      fetchImpl,
      timeoutMs: options.timeoutMs ?? PACKUMENT_TIMEOUT_MS,
      maxBytes: PACKUMENT_MAX_BYTES,
    },
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RegistryError("Metadata registry bukan JSON yang valid.", "bad-response");
  }
  return parsePackument(parsed);
}

/** Mengambil hanya field yang dipakai; bentuk lain ditolak. */
export function parsePackument(value: unknown): Packument {
  if (!isRecord(value)) {
    throw new RegistryError("Bentuk metadata registry tidak dikenal.", "bad-response");
  }
  const tags = value["dist-tags"];
  if (!isRecord(tags)) {
    throw new RegistryError("Metadata registry tidak memuat dist-tags.", "bad-response");
  }
  const latestRaw = tags["latest"];
  const latest = typeof latestRaw === "string" && latestRaw !== "" ? latestRaw : null;

  const versionsRaw = value["versions"];
  if (!isRecord(versionsRaw)) {
    throw new RegistryError("Metadata registry tidak memuat versions.", "bad-response");
  }

  const versions: Record<string, PackumentVersion> = {};
  for (const [key, entry] of Object.entries(versionsRaw)) {
    if (!isValidSdkVersion(key)) continue;
    if (!isRecord(entry)) {
      throw new RegistryError("Bentuk metadata versi tidak dikenal.", "bad-response");
    }
    const dist = entry["dist"];
    if (!isRecord(dist)) {
      throw new RegistryError("Metadata versi tidak memuat dist.", "bad-response");
    }
    const integrity = dist["integrity"];
    const tarball = dist["tarball"];
    if (typeof integrity !== "string" || integrity === "") {
      throw new RegistryError("Metadata versi tidak memuat nilai integritas.", "bad-response");
    }
    if (typeof tarball !== "string" || tarball === "") {
      throw new RegistryError("Metadata versi tidak memuat alamat tarball.", "bad-response");
    }
    const unpackedSize = dist["unpackedSize"];
    versions[key] = {
      version: key,
      integrity,
      tarball,
      ...(typeof unpackedSize === "number" && Number.isFinite(unpackedSize)
        ? { unpackedSize }
        : {}),
    };
  }

  if (Object.keys(versions).length === 0) {
    throw new RegistryError(
      "Metadata registry tidak memuat versi yang bisa dipakai.",
      "bad-response",
    );
  }
  return { latest, versions };
}

/* ------------------------------------------------------------------ versi */

/**
 * Memilih versi SDK yang akan dipasang.
 *
 * `requested` kosong atau `latest` memakai `dist-tags.latest` bila berada
 * di rentang yang didukung dan bukan prarilis; kalau tidak, versi tertinggi
 * yang stabil dalam rentang dipakai dan disertai catatan.
 */
export function pickVersion(input: {
  versions: Record<string, PackumentVersion>;
  latest: string | null;
  requested?: string;
}): PickedVersion {
  const { versions, latest } = input;
  const requested = (input.requested ?? "").trim();

  if (requested !== "" && requested !== "latest") {
    if (!isValidSdkVersion(requested)) {
      throw new RegistryError(
        `Versi "${requested}" bukan semver yang valid.`,
        "invalid",
      );
    }
    const entry = versions[requested];
    if (entry === undefined) {
      throw new RegistryError(
        `Versi ${requested} tidak ada di registry npm.`,
        "not-found",
      );
    }
    if (!isWithinRange(requested)) {
      throw new RegistryError(
        `Versi ${requested} di luar rentang yang didukung (${SDK_SUPPORTED_RANGE}).`,
        "out-of-range",
      );
    }
    return toPicked(entry);
  }

  const latestEntry = latest === null ? undefined : versions[latest];
  if (
    latest !== null &&
    latestEntry !== undefined &&
    !isPrerelease(latest) &&
    isWithinRange(latest)
  ) {
    return toPicked(latestEntry);
  }

  const candidates = Object.keys(versions)
    .filter((version) => !isPrerelease(version) && isWithinRange(version))
    .sort((a, b) => Bun.semver.order(a, b));
  const chosen = candidates[candidates.length - 1];
  if (chosen === undefined) {
    throw new RegistryError(
      `Tidak ada versi SDK dalam rentang yang didukung (${SDK_SUPPORTED_RANGE}).`,
      "not-found",
    );
  }

  const entry = versions[chosen];
  if (entry === undefined) {
    throw new RegistryError("Metadata registry tidak memuat versi terpilih.", "bad-response");
  }

  let note: string;
  if (latest === null) {
    note = `Registry tidak menandai versi terbaru; versi ${chosen} yang dipasang.`;
  } else if (isPrerelease(latest)) {
    note = `Versi terbaru di registry (${latest}) masih prarilis; versi ${chosen} yang dipasang.`;
  } else {
    note = `Versi terbaru di registry (${latest}) di luar rentang yang didukung (${SDK_SUPPORTED_RANGE}); versi ${chosen} yang dipasang.`;
  }

  return { ...toPicked(entry), note };
}

function toPicked(entry: PackumentVersion): PickedVersion {
  return {
    version: entry.version,
    integrity: entry.integrity,
    ...(entry.unpackedSize === undefined ? {} : { unpackedSize: entry.unpackedSize }),
  };
}

/* --------------------------------------------------------------- unduhan */

/**
 * Mengunduh tarball SDK.
 *
 * URL dibangun sendiri dari pola tetap; `expectedTarball` dari metadata
 * hanya dibandingkan dan tidak pernah dipakai mengunduh. Metadata yang
 * menunjuk host lain dianggap mencurigakan dan ditolak.
 *
 * `timeoutMs` hanya dipakai pengujian; nilai bawaannya tetap 120 detik.
 */
export async function downloadTarball(
  version: string,
  options: {
    fetch?: FetchLike;
    expectedTarball?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ gz: Uint8Array }> {
  if (!isValidSdkVersion(version)) {
    throw new RegistryError(`Versi "${version}" bukan semver yang valid.`, "invalid");
  }
  if (
    options.expectedTarball !== undefined &&
    !isTrustedRegistryUrl(options.expectedTarball)
  ) {
    throw new RegistryError(
      "Alamat tarball dari metadata registry mencurigakan; unduhan ditolak.",
      "bad-response",
    );
  }

  const fetchImpl = options.fetch ?? fetch;
  const bytes = await fetchLimited(
    buildTarballUrl(version),
    {
      method: "GET",
      headers: { accept: "application/octet-stream" },
      credentials: "omit",
      redirect: "manual",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    {
      fetchImpl,
      timeoutMs: options.timeoutMs ?? TARBALL_TIMEOUT_MS,
      maxBytes: TARBALL_MAX_BYTES,
    },
  );
  return { gz: bytes };
}
