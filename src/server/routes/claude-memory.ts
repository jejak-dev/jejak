import { Elysia } from "elysia";
import { join, relative, sep } from "node:path";
import {
  claudeConfigRoot,
  claudeMemoryDir,
  claudeProjectLabel,
  claudeWorktreeOrigin,
  listClaudeMemories,
  mergeClaudeListings,
  resolveClaudeProject,
  type ClaudeMemoryItem,
  type ClaudeProjectEntry,
} from "../memory/claude-memory";
import { jejakHome } from "../provider-store";

export interface ClaudeMemoryRoutesOptions {
  /** Proyek yang dikenal Jejak (kunci proyek -> path). */
  projects?: () => ClaudeProjectEntry[];
  /** Lingkungan proses; dipakai `CLAUDE_CONFIG_DIR` dan `JEJAK_HOME`. */
  env?: Record<string, string | undefined>;
  /** Direktori home pengguna; default `os.homedir()`. */
  home?: string;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** True bila `path` berada di dalam `root`. */
function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

/**
 * Rute baca-saja memory Claude Code. Rute ini ada di bawah `/api/` sehingga
 * penjaga Host/Origin dan penjaga autentikasi yang sama dengan rute memory
 * lain berlaku otomatis. Tidak ada penulisan ke folder Claude.
 */
export function claudeMemoryRoutes(options: ClaudeMemoryRoutesOptions = {}): Elysia {
  const env = options.env ?? process.env;
  const configRoot = claudeConfigRoot(env, options.home);
  const worktreesRoot = join(jejakHome(env), "worktrees");

  const plugin = new Elysia({ name: "jejak-claude-memory-routes" });

  return plugin.get("/api/memory/claude", async ({ query }) => {
    const record = (query ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "project") {
        return jsonResponse(400, { error: `Parameter "${key}" tidak dikenal.` });
      }
    }
    const raw = record.project;
    if (typeof raw !== "string" || raw.trim() === "") {
      return jsonResponse(400, { error: "Parameter project wajib diisi." });
    }
    const key = raw.trim();

    const entries = options.projects?.() ?? [];
    const entry = resolveClaudeProject(entries, key);
    if (entry === undefined) {
      return jsonResponse(404, { error: "Proyek tidak dikenal." });
    }

    // Claude Code bisa memakai path mentah atau path yang sudah di-resolve
    // (mis. `/var` vs `/private/var` di macOS); keduanya dibaca lalu digabung.
    const candidates = [entry.path, ...(entry.altPaths ?? [])];

    // Worktree Jejak: repo asal diketahui dari data sesi; bila tak ada,
    // dicoba dari metadata git worktree. Bila tetap tak diketahui, hanya
    // folder proyek yang dicek.
    let origin = entry.originPath;
    if (origin === undefined) {
      for (const candidate of candidates) {
        if (!insideRoot(worktreesRoot, candidate)) continue;
        origin = await claudeWorktreeOrigin(candidate);
        if (origin !== undefined) break;
      }
    }
    const originLabel = origin === undefined ? undefined : claudeProjectLabel(origin);

    const dirs: {
      label: string;
      dirExists: boolean;
      items: ClaudeMemoryItem[];
    }[] = [];

    const first = mergeClaudeListings(
      await Promise.all(
        candidates.map((path) => listClaudeMemories(claudeMemoryDir(configRoot, path))),
      ),
    );
    dirs.push({
      label:
        originLabel === undefined
          ? claudeProjectLabel(entry.path)
          : `${originLabel} (worktree)`,
      dirExists: first.dirExists,
      items: first.items,
    });

    if (origin !== undefined && origin !== entry.path) {
      const originAlternates =
        entry.originAltPath === undefined ? [] : [entry.originAltPath];
      const second = mergeClaudeListings(
        await Promise.all(
          [origin, ...originAlternates].map((path) =>
            listClaudeMemories(claudeMemoryDir(configRoot, path)),
          ),
        ),
      );
      dirs.push({
        label: originLabel ?? claudeProjectLabel(origin),
        dirExists: second.dirExists,
        items: second.items,
      });
    }

    return {
      project: originLabel ?? claudeProjectLabel(entry.path),
      dirs,
    };
  }) as unknown as Elysia;
}
