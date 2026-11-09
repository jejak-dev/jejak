/** Kunci per akar repo agar mutasi git ke repo yang sama berjalan berurutan. */
const locks = new Map<string, Promise<void>>();

export async function withLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  locks.set(root, queued);
  try {
    await previous;
    return await task();
  } finally {
    release();
    if (locks.get(root) === queued) locks.delete(root);
  }
}
