import { Elysia } from "elysia";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CommandCatalog } from "../sessions/command-catalog";
import type { SessionManager } from "../sessions/session-manager";

export interface CommandRoutesOptions {
  /** Katalog perintah; membaca daftar lewat runner lalu menyimpan sebentar. */
  catalog: CommandCatalog;
  /** Manajer sesi; sumber untuk pengaturan Claude (skill aktif, dst). */
  manager: SessionManager;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function queryRecord(query: unknown): Record<string, unknown> {
  return typeof query === "object" && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

/** Baca `cwd` dari query; galat 400 dalam bahasa Indonesia. */
async function readCwd(
  query: unknown,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const raw = queryRecord(query).cwd;
  if (raw === undefined || raw === "") {
    return { ok: false, error: "Parameter cwd wajib diisi." };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "Parameter cwd tidak valid." };
  }
  const cwd = raw.trim();
  if (cwd === "") {
    return { ok: false, error: "Parameter cwd wajib diisi." };
  }
  if (!isAbsolute(cwd)) {
    return { ok: false, error: "Parameter cwd harus berupa path absolut." };
  }
  let isDirectory = false;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { ok: false, error: "Folder kerja tidak ditemukan atau bukan direktori." };
  }
  return { ok: true, cwd };
}

export function commandRoutes(options: CommandRoutesOptions): Elysia {
  const plugin = new Elysia({ name: "jejak-command-routes" }).get(
    "/api/commands",
    async ({ query }) => {
      const parsed = await readCwd(query);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });
      // Pengaturan Claude dibaca dengan cara yang sama seperti saat giliran
      // berjalan, agar daftar perintah sama dengan yang dilihat model.
      const context = options.manager.commandContext(parsed.cwd);
      const result = await options.catalog.get({
        cwd: parsed.cwd,
        ...(context.claude === undefined ? {} : { claude: context.claude }),
      });
      return { commands: result.commands, source: result.source };
    },
  );

  return plugin as unknown as Elysia;
}
