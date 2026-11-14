import { Elysia } from "elysia";

export interface GuardOptions {
  /** Nama host tanpa port yang diizinkan. Default: 127.0.0.1, localhost, [::1]. */
  allowedHosts?: string[];
  /** Awalan path yang dijaga Host/Origin. Default: hanya `/api/`. */
  guardedPrefixes?: string[];
}

export const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function localGuard(options: GuardOptions = {}): Elysia {
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.trim().toLowerCase()),
  );
  const guardedPrefixes = options.guardedPrefixes ?? ["/api/"];

  const plugin = new Elysia({ name: "jejak-local-guard" }).onBeforeHandle(
    { as: "global" },
    ({ request }) => {
      const url = new URL(request.url);
      if (!guardedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
        return;
      }

      const rawHost = request.headers.get("host")?.trim() || url.host;
      if (!allowedHosts.has(hostnameOf(rawHost))) {
        return deny(403, "host tidak diizinkan");
      }

      const origin = request.headers.get("origin");
      if (origin !== null) {
        let originUrl: URL;
        try {
          originUrl = new URL(origin);
        } catch {
          return deny(403, "origin tidak diizinkan");
        }
        const schemeOk = originUrl.protocol === "http:" || originUrl.protocol === "https:";
        if (!schemeOk || originUrl.host.toLowerCase() !== rawHost.toLowerCase()) {
          return deny(403, "origin tidak diizinkan");
        }
      }

      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const contentType = request.headers.get("content-type");
        if (contentType === null || !contentType.trim().toLowerCase().startsWith("application/json")) {
          return deny(415, "content-type harus application/json");
        }
      }
    },
  );

  return plugin as unknown as Elysia;
}
