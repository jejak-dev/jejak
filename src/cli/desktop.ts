import { read } from "node:fs";

export interface DesktopLifecycleOptions {
  /** Aksi berhenti sebelum proses keluar (mis. menutup server). */
  stop?: () => void | Promise<void>;
}

/**
 * Pasang pendengar "mati bersama induk" untuk mode desktop:
 * EOF pada stdin (pipa, FIFO, atau berkas) serta SIGTERM dan SIGINT
 * membuat proses keluar dengan kode 0.
 *
 * EOF dibaca langsung dari fd 0 karena `process.stdin` Bun tidak selalu
 * melaporkan EOF pada FIFO (hanya pada pipa).
 */
export function installDesktopLifecycle(options: DesktopLifecycleOptions = {}): void {
  let berhenti = false;
  const shutdown = (): void => {
    if (berhenti) return;
    berhenti = true;
    try {
      void options.stop?.();
    } catch {
      // Kegagalan menutup server tidak boleh menahan proses keluar.
    }
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const buffer = Buffer.alloc(256);
  const baca = (): void => {
    read(0, buffer, 0, buffer.length, null, (error, bytes) => {
      if (error !== null && error !== undefined) {
        // stdin tak bisa dibaca (mis. sudah ditutup paksa): anggap EOF.
        shutdown();
        return;
      }
      if (bytes === 0) {
        // EOF: induk menutup stdin.
        shutdown();
        return;
      }
      // Isi dari induk diabaikan; lanjut menunggu EOF.
      baca();
    });
  };
  try {
    baca();
  } catch {
    // Tanpa stdin yang bisa dibaca, proses tetap hidup karena server.
  }
}
