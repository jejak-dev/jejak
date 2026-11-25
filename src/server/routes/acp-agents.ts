import { Elysia } from "elysia";
import { ACP_AGENTS, getAcpAgent } from "../acp/agent-defs";
import { probeAgentById, type AcpAgentStatus } from "../acp/agent-probe";
import type { AuditStore } from "../audit/audit-store";
import { recordAudit } from "../audit/record";

/** Ringkasan satu agent untuk daftar di halaman Pengaturan (tanpa menjalankannya). */
export interface AcpAgentInfo {
  id: string;
  label: string;
  installed: boolean;
  installHint: string;
  loginHint: string;
}

export interface AcpAgentsRoutesOptions {
  /** Probe satu agent; bawaan `probeAgentById(id, cwd)`. */
  probe?: (id: string) => Promise<AcpAgentStatus | undefined>;
  /** Pencari perintah di PATH; bawaan `Bun.which`. */
  which?: (cmd: string) => string | null;
  /** Direktori kerja probe; folder Jejak home, bukan proyek pengguna. */
  cwd: string;
  /** Penyimpanan log audit; tanpa opsi ini tidak ada pencatatan. */
  audit?: AuditStore;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function acpAgentsRoutes(options: AcpAgentsRoutesOptions): Elysia {
  const plugin = new Elysia({ name: "jejak-acp-agents-routes" });
  const which = options.which ?? ((cmd: string) => Bun.which(cmd));
  const probe =
    options.probe ??
    ((id: string): Promise<AcpAgentStatus | undefined> => probeAgentById(id, options.cwd));

  // Satu penerbangan per id: panggilan bersamaan berbagi promise yang sama
  // supaya proses agent tidak bertumpuk. Entri dilepas setelah selesai.
  const berjalan = new Map<string, Promise<AcpAgentStatus>>();

  const probeSekali = (id: string): Promise<AcpAgentStatus> => {
    const sedang = berjalan.get(id);
    if (sedang !== undefined) return sedang;
    const janji = (async (): Promise<AcpAgentStatus> => {
      const status = await probe(id);
      if (status === undefined) {
        // Seharusnya tak terjadi: id sudah diperiksa sebelum masuk sini.
        throw new Error(`Agent "${id}" tidak dikenal.`);
      }
      recordAudit(options.audit, {
        kind: "pengaturan",
        summary: `Probe agent ${status.label}: ${status.state}`,
        meta: { aksi: "acp-probe", agent: status.id, state: status.state },
      });
      return status;
    })();
    berjalan.set(id, janji);
    void janji.finally(() => {
      berjalan.delete(id);
    }).catch(() => undefined);
    return janji;
  };

  return plugin
    .get("/api/acp/agents", () => ({
      agents: Object.values(ACP_AGENTS).map((def): AcpAgentInfo => {
        const perintah = def.command[0];
        return {
          id: def.id,
          label: def.label,
          installed: perintah !== undefined && which(perintah) !== null,
          installHint: def.installHint,
          loginHint: def.loginHint,
        };
      }),
    }))
    .post("/api/acp/agents/:id/probe", async ({ params }) => {
      // `getAcpAgent` menolak nama bawaan prototipe (`__proto__`, `constructor`).
      const def = getAcpAgent(params.id);
      if (def === undefined) {
        return jsonResponse(404, { error: `Agent "${params.id}" tidak dikenal.` });
      }
      return probeSekali(def.id);
    }) as unknown as Elysia;
}
