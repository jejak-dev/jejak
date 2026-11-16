import { Elysia } from "elysia";
import type { AuditStore } from "../audit/audit-store";
import {
  NetworkError,
  recordNetworkAudit,
  type NetworkManager,
} from "../network/network-manager";
import {
  MAX_NETWORK_PORT,
  MIN_NETWORK_PORT,
  isValidNetworkPort,
} from "../network/network-store";

export interface NetworkRoutesOptions {
  /** Manajer jaringan; tanpa ini rute menjawab 404. */
  network?: NetworkManager;
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

/** Pesan galat untuk port tak sah. */
export const INVALID_PORT_MESSAGE = `Port harus antara ${MIN_NETWORK_PORT} dan ${MAX_NETWORK_PORT}.`;

/** Rute pengaturan akses dari jaringan. */
export function networkRoutes(options: NetworkRoutesOptions): Elysia {
  const manager = options.network;
  const audit = options.audit;

  const plugin = new Elysia({ name: "jejak-network-routes" })
    .get("/api/network", () => {
      if (manager === undefined) {
        return jsonResponse(404, { error: "akses jaringan tidak tersedia" });
      }
      return jsonResponse(200, manager.status());
    })
    .put(
      "/api/network",
      async ({ body }) => {
        if (manager === undefined) {
          return jsonResponse(404, { error: "akses jaringan tidak tersedia" });
        }

        const payload = parseBody(body);
        const enabled = payload.enabled;
        if (typeof enabled !== "boolean") {
          return jsonResponse(400, { error: "Nilai 'enabled' harus berupa boolean." });
        }
        const port = payload.port;
        if (port !== undefined && !isValidNetworkPort(port)) {
          return jsonResponse(400, { error: INVALID_PORT_MESSAGE });
        }

        if (!enabled) {
          const status = await manager.disable();
          recordNetworkAudit(audit, "jaringan-dimatikan", status.port);
          return jsonResponse(200, status);
        }

        try {
          const status = await manager.enable(port as number | undefined);
          recordNetworkAudit(audit, "jaringan-diaktifkan", status.port);
          return jsonResponse(200, status);
        } catch (error) {
          if (error instanceof NetworkError) {
            if (error.code === "sandi-kurang") {
              return jsonResponse(409, { error: "Buat sandi dulu." });
            }
            if (error.code === "port-tak-sah") {
              return jsonResponse(400, { error: error.message });
            }
            return jsonResponse(409, { error: error.message });
          }
          return jsonResponse(500, { error: "Gagal menyalakan akses jaringan." });
        }
      },
      { parse: "text" },
    );

  return plugin as unknown as Elysia;
}
