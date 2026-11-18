/**
 * Penggabung potongan keluaran PTY menjadi satu frame per flush.
 *
 * Satu pembacaan PTY sering hanya beberapa byte (produsen berorientasi baris),
 * sehingga mengirim satu frame per pembacaan menghabiskan soket untuk header.
 * Antrean ini menahan potongan sampai 4 ms atau 8 KiB, lalu mengirimnya
 * sebagai satu frame. Tak ada byte yang dibuang: flush selalu mengirim semua
 * yang sudah diterima.
 */

/** Jeda tenang sebelum frame parsial dikirim. */
export const OUTPUT_FLUSH_MS = 4;

/** Ukuran tertunda yang memaksa flush tanpa menunggu timer. */
export const OUTPUT_FLUSH_BYTES = 8 * 1024;

export interface OutputQueue {
  /** Terima satu pembacaan PTY; kirim seketika bila frame sudah penuh. */
  push(bytes: Uint8Array): void;
  /** Kirim semua yang tertunda (dipakai sebelum replay dan frame kendali). */
  flush(): void;
  /** Buang byte tertunda dan timer; penonton sedang dilepas. */
  dispose(): void;
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const frame = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.length;
  }
  return frame;
}

/** Satu antrean per penonton; `sink` menerima frame yang sudah digabung. */
export function createOutputQueue(sink: (frame: Uint8Array) => void): OutputQueue {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingBytes === 0) return;
    // Satu pembacaan diteruskan apa adanya: menyalinnya tak membeli apa pun.
    const frame = pending.length === 1 ? pending[0]! : join(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    sink(frame);
  };

  return {
    push(bytes) {
      if (bytes.length === 0) return;
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes >= OUTPUT_FLUSH_BYTES) {
        flush();
        return;
      }
      if (timer === null) {
        timer = setTimeout(flush, OUTPUT_FLUSH_MS);
        // Flush tertunda tak boleh menahan proses saat server berhenti.
        (timer as { unref?: () => void }).unref?.();
      }
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = [];
      pendingBytes = 0;
    },
  };
}
