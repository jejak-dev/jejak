import { Elysia } from "elysia";
import { browseDirs, BrowseError, type BrowseResult } from "../files/browse";

export type { BrowseResult };

export interface FsRoutesOptions {
  /** Folder awal saat query `path` kosong; default `os.homedir()`. */
  home?: string;
  /** false -> semua rute menjawab 503. */
  enabled?: boolean;
}

const DISABLED = "Penelusur folder dimatikan.";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function fsRoutes(options: FsRoutesOptions = {}): Elysia {
  const enabled = options.enabled ?? true;

  const plugin = new Elysia({ name: "jejak-fs-routes" }).get(
    "/api/fs/dirs",
    async ({ query }) => {
      if (!enabled) {
        return jsonResponse(503, { error: DISABLED });
      }
      try {
        const browseOptions = options.home === undefined ? {} : { home: options.home };
        return await browseDirs(query.path, browseOptions);
      } catch (error) {
        if (error instanceof BrowseError) {
          return jsonResponse(error.status, { error: error.message });
        }
        return jsonResponse(400, { error: "Permintaan tidak valid." });
      }
    },
  );

  return plugin as unknown as Elysia;
}