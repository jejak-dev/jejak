/**
 * Input prompt streaming untuk SDK (jalur "Arahkan").
 *
 * Prompt normal adalah string. Prompt streaming adalah `AsyncIterable` pesan
 * user: pesan pertama membuka giliran, pesan susulan (`priority: "next"`)
 * disisipkan ke giliran yang sedang berjalan tanpa membatalkannya.
 */

/** Bentuk pesan user yang diterima SDK. */
export interface SteerUserMessage {
  type: "user";
  parent_tool_use_id: null;
  message: { role: "user"; content: string };
  /** "next" dipakai SDK supaya pesan dipakai di giliran yang sama. */
  priority?: "next";
}

export interface SteerInput {
  /** Rentetan prompt untuk SDK. */
  iterable: AsyncIterable<SteerUserMessage>;
  /** Dorong pesan ke giliran berjalan; `false` bila giliran tak menerima lagi. */
  steer(text: string): boolean;
  /** Tutup input; generator selesai bila antrean kosong. */
  close(): void;
  /** Jumlah pesan antrean yang belum dibaca iterator. */
  pendingCount(): number;
}

function userMessage(text: string, priority?: "next"): SteerUserMessage {
  const message: SteerUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
  if (priority !== undefined) message.priority = priority;
  return message;
}

/**
 * Prompt streaming: pesan pertama lalu pesan susulan dari `steer`.
 *
 * Generator menunggu bila antrean kosong dan input belum ditutup; saat
 * ditutup dan antrean kosong, iterasi selesai sehingga SDK menutup giliran.
 */
export function createSteerInput(firstPrompt: string): SteerInput {
  const queue: SteerUserMessage[] = [userMessage(firstPrompt)];
  let closed = false;
  let wake: (() => void) | undefined;

  const notify = (): void => {
    const lanjut = wake;
    wake = undefined;
    lanjut?.();
  };

  const iterable: AsyncIterable<SteerUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };

  return {
    iterable,
    steer(text: string): boolean {
      if (closed) return false;
      queue.push(userMessage(text, "next"));
      notify();
      return true;
    },
    close(): void {
      closed = true;
      notify();
    },
    pendingCount(): number {
      return queue.length;
    },
  };
}

/**
 * Jumlah kiriman user yang masih menunggu menurut pesan `result` SDK.
 *
 * Nilai di atas 0 berarti ada giliran lanjutan yang belum selesai, jadi
 * pesan `result` itu belum final.
 */
export function queuedTurnCountOf(message: unknown): number {
  if (typeof message !== "object" || message === null) return 0;
  const value = (message as { queued_turn_count?: unknown }).queued_turn_count;
  return typeof value === "number" && value > 0 ? value : 0;
}
