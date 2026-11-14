import type { CdpConnection, CdpEventHandler } from "../src/server/browser/cdp-client";

/** Target palsu yang dikelola koneksi palsu. */
export interface TargetPalsu {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/** Riwayat navigasi palsu. */
export interface RiwayatPalsu {
  currentIndex: number;
  entries: Array<{ id: number; url: string }>;
}

/**
 * Koneksi CDP palsu yang mendukung banyak target.
 *
 * Mencatat semua panggilan, mengelola target/tab, dan bisa menyiarkan
 * peristiwa CDP (sesi maupun tingkat browser).
 */
export class KoneksiPalsu implements CdpConnection {
  readonly panggilan: Array<{ method: string; params?: unknown; sessionId?: string }> = [];
  readonly targets = new Map<string, TargetPalsu>();
  /** Peta sessionId -> targetId. */
  readonly sesi = new Map<string, string>();
  /** Riwayat navigasi yang dikembalikan `Page.getNavigationHistory`. */
  riwayat: RiwayatPalsu = { currentIndex: 0, entries: [{ id: 0, url: "about:blank" }] };
  /** Target yang terakhir diaktifkan. */
  aktif: string | undefined;
  /** Teks pilihan yang dikembalikan `Runtime.evaluate`. */
  pilihan = "";
  /** Data screenshot palsu. */
  dataScreenshot = "YmVuaWgtMTE=";
  /** Bila true, `Page.captureScreenshot` tak pernah selesai. */
  tahanScreenshot = false;
  /** Sesi terakhir yang memasang `Page.handleJavaScriptDialog`. */
  dialog: { accept: boolean; sessionId?: string } | undefined;
  private readonly pendengar = new Map<string, Set<CdpEventHandler>>();
  private counter = 0;
  /** True bila soket sudah ditutup. */
  tertutup = false;

  /** Tambah target halaman baru ke daftar. */
  addTarget(targetId: string, url = "about:blank", title = ""): TargetPalsu {
    const target: TargetPalsu = { targetId, type: "page", url, title };
    this.targets.set(targetId, target);
    return target;
  }

  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    this.panggilan.push({ method, params, sessionId });
    switch (method) {
      case "Target.getTargets":
        return {
          targetInfos: [...this.targets.values()].map((target) => ({
            targetId: target.targetId,
            type: target.type,
            url: target.url,
            title: target.title,
          })),
        };
      case "Target.attachToTarget": {
        const targetId = (params as { targetId?: string } | undefined)?.targetId ?? "";
        if (!this.targets.has(targetId)) this.addTarget(targetId);
        const session = `S-${targetId}`;
        this.sesi.set(session, targetId);
        return { sessionId: session };
      }
      case "Target.detachFromTarget":
        return {};
      case "Target.createTarget": {
        const url = (params as { url?: string } | undefined)?.url ?? "about:blank";
        this.counter += 1;
        const targetId = `X${this.counter}`;
        this.addTarget(targetId, url);
        return { targetId };
      }
      case "Target.closeTarget": {
        const targetId = (params as { targetId?: string } | undefined)?.targetId ?? "";
        this.targets.delete(targetId);
        return {};
      }
      case "Target.getTargetInfo": {
        const targetId = (params as { targetId?: string } | undefined)?.targetId ?? "";
        const target = this.targets.get(targetId);
        return { targetInfo: { url: target?.url ?? "", title: target?.title ?? "" } };
      }
      case "Target.activateTarget":
        this.aktif = (params as { targetId?: string } | undefined)?.targetId;
        return {};
      case "Page.navigate": {
        const url = (params as { url?: string } | undefined)?.url ?? "";
        const target = this.targets.get(this.sesi.get(sessionId ?? "") ?? "");
        if (target !== undefined) target.url = url;
        return { frameId: "F1" };
      }
      case "Page.getNavigationHistory":
        return { currentIndex: this.riwayat.currentIndex, entries: this.riwayat.entries };
      case "Page.navigateToHistoryEntry": {
        const entryId = (params as { entryId?: number } | undefined)?.entryId;
        const index = this.riwayat.entries.findIndex((entry) => entry.id === entryId);
        if (index >= 0) {
          this.riwayat.currentIndex = index;
          const target = this.targets.get(this.sesi.get(sessionId ?? "") ?? "");
          const entry = this.riwayat.entries[index];
          if (target !== undefined && entry !== undefined) target.url = entry.url;
        }
        return {};
      }
      case "Page.reload":
      case "Page.stopLoading":
      case "Page.enable":
      case "Runtime.enable":
      case "Page.stopScreencast":
        return {};
      case "Page.startScreencast":
        return {};
      case "Page.captureScreenshot":
        if (this.tahanScreenshot) return new Promise<never>(() => undefined);
        return { data: this.dataScreenshot };
      case "Page.handleJavaScriptDialog": {
        this.dialog = {
          accept: (params as { accept?: boolean } | undefined)?.accept === true,
          sessionId,
        };
        return {};
      }
      case "Runtime.evaluate":
        return { result: { value: this.pilihan } };
      default:
        return {};
    }
  }

  on(event: string, handler: CdpEventHandler, sessionId?: string): () => void {
    const key = sessionId === undefined ? event : `${event}@${sessionId}`;
    const set = this.pendengar.get(key) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.pendengar.set(key, set);
    return () => {
      set.delete(handler);
    };
  }

  close(): void {
    this.tertutup = true;
  }

  /** Sambungkan peristiwa ke pendengar yang cocok. */
  emit(event: string, params: unknown, sessionId?: string): void {
    for (const handler of this.pendengar.get(event) ?? []) handler(params, sessionId);
    if (sessionId !== undefined) {
      for (const handler of this.pendengar.get(`${event}@${sessionId}`) ?? []) {
        handler(params, sessionId);
      }
    }
  }

  /** Semua panggilan dengan metode tertentu. */
  calls(method: string): Array<{ method: string; params?: unknown; sessionId?: string }> {
    return this.panggilan.filter((call) => call.method === method);
  }
}
