import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";
import { VIA_HEADER, VIA_NETWORK } from "../network/network-fetch";
import { TunnelError, type TunnelManager } from "../network/tunnel-manager";

export interface TunnelRoutesOptions {
  /** Manajer tunnel; tanpa ini rute menjawab 404. */
  tunnel?: TunnelManager;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "string" || body.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** True bila permintaan datang lewat listener jaringan (bukan loopback). */
function fromNetwork(request: Request): boolean {
  return request.headers.get(VIA_HEADER) === VIA_NETWORK;
}

/** Catat audit perubahan tunnel; nilai token tak pernah ikut. */
function recordTunnelAudit(
  audit: AuditStore | undefined,
  action: "tunnel-diaktifkan" | "tunnel-dimatikan" | "tunnel-token-dihapus",
): void {
  recordAudit(audit, {
    kind: "pengaturan",
    summary: `Tunnel: ${action}`,
    meta: { aksi: action },
  });
}

/**
 * Rute Cloudflare Tunnel.
 *
 * Pengaturan tunnel hanya boleh diubah dari listener utama (loopback): dari
 * listener jaringan semua perubahan dijawab 403, supaya penyerang yang berhasil
 * login dari internet tak bisa membuka atau mengubah tunnel. GET tetap boleh.
 */
export function tunnelRoutes(options: TunnelRoutesOptions): Elysia {
  const manager = options.tunnel;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-tunnel-routes" })
    .get("/api/tunnel", () => {
      if (manager === undefined) {
        return jsonResponse(404, { error: "tunnel tidak tersedia" });
      }
      // GET dari listener jaringan tetap boleh: status tak memuat rahasia.
      return jsonResponse(200, manager.status());
    })
    .put(
      "/api/tunnel",
      async ({ request, body }) => {
        if (manager === undefined) {
          return jsonResponse(404, { error: "tunnel tidak tersedia" });
        }
        if (fromNetwork(request)) {
          return jsonResponse(403, {
            error: "Pengaturan tunnel hanya bisa diubah dari perangkat ini.",
          });
        }

        const payload = parseBody(body);
        const enabled = payload.enabled;
        if (typeof enabled !== "boolean") {
          return jsonResponse(400, { error: "Nilai 'enabled' harus berupa boolean." });
        }
        const publicHost = payload.publicHost;
        if (publicHost !== undefined && typeof publicHost !== "string") {
          return jsonResponse(400, { error: "Nilai 'publicHost' harus berupa teks." });
        }
        const token = payload.token;
        if (token !== undefined && typeof token !== "string") {
          return jsonResponse(400, { error: "Nilai 'token' harus berupa teks." });
        }

        if (!enabled) {
          const status = await manager.disable();
          recordTunnelAudit(audit, "tunnel-dimatikan");
          return jsonResponse(200, status);
        }

        try {
          const status = await manager.enable({
            ...(publicHost === undefined || publicHost === "" ? {} : { publicHost }),
            // String kosong tidak menghapus token tersimpan.
            ...(token === undefined || token === "" ? {} : { token }),
          });
          recordTunnelAudit(audit, "tunnel-diaktifkan");
          return jsonResponse(200, status);
        } catch (error) {
          if (error instanceof TunnelError) {
            if (error.code === "host-tak-sah" || error.code === "token-tak-sah") {
              return jsonResponse(400, { error: error.message });
            }
            return jsonResponse(409, { error: error.message });
          }
          return jsonResponse(500, { error: "Gagal menyalakan tunnel." });
        }
      },
      { parse: "text" },
    )
    .delete("/api/tunnel/token", async ({ request }) => {
      if (manager === undefined) {
        return jsonResponse(404, { error: "tunnel tidak tersedia" });
      }
      if (fromNetwork(request)) {
        return jsonResponse(403, {
          error: "Pengaturan tunnel hanya bisa diubah dari perangkat ini.",
        });
      }
      await manager.disable();
      manager.clearToken();
      recordTunnelAudit(audit, "tunnel-token-dihapus");
      return jsonResponse(200, manager.status());
    });

  return plugin as unknown as Elysia;
}
