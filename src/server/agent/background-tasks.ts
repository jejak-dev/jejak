import type { AgentEvent, BackgroundTaskStatus } from "./events";

/** Satu tugas latar belakang sebuah sesi, hasil lipatan event `bg_task`. */
export interface BackgroundTask {
  taskId: string;
  status: BackgroundTaskStatus;
  description: string;
  kind?: string;
  toolUseId?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
  /** Berhenti karena giliran berakhir (proses CLI ditutup), bukan atas permintaan. */
  endedByTurn?: boolean;
}

const MAX_TASKS = 100;

/**
 * Lipat event sesi menjadi daftar tugas latar (urutan mulai). Murni.
 *
 * - `bg_task` menambah/memperbarui; status akhir tak dibuka kembali.
 * - `bg_tasks_sync` menghentikan tugas latar "running" yang tak ada di himpunan.
 * - `result` (akhir giliran) menghentikan semua yang masih "running": proses
 *   CLI ditutup di akhir giliran sehingga tugas latar ikut mati.
 * Tugas latar depan (`background === false`) tak masuk daftar.
 */
export function foldBackgroundTasks(events: readonly AgentEvent[]): BackgroundTask[] {
  const tasks = new Map<string, BackgroundTask>();
  const foreground = new Set<string>();
  for (const event of events) {
    if (event.type === "bg_task") {
      if (event.background === false) {
        if (!tasks.has(event.taskId)) foreground.add(event.taskId);
        continue;
      }
      if (event.background === true) foreground.delete(event.taskId);
      if (foreground.has(event.taskId)) continue;
      const current = tasks.get(event.taskId);
      if (current === undefined) {
        const task: BackgroundTask = {
          taskId: event.taskId,
          status: event.status,
          description: event.description ?? event.taskId,
          startedAt: event.at,
        };
        if (event.kind !== undefined) task.kind = event.kind;
        if (event.toolUseId !== undefined) task.toolUseId = event.toolUseId;
        if (event.summary !== undefined) task.summary = event.summary;
        if (event.status !== "running") task.endedAt = event.at;
        tasks.set(event.taskId, task);
        continue;
      }
      if (event.description !== undefined) current.description = event.description;
      if (event.kind !== undefined) current.kind = event.kind;
      if (event.toolUseId !== undefined) current.toolUseId = event.toolUseId;
      if (event.summary !== undefined) current.summary = event.summary;
      if (current.status === "running" && event.status !== "running") {
        current.status = event.status;
        current.endedAt = event.at;
      }
    } else if (event.type === "bg_tasks_sync") {
      const live = new Set(event.taskIds);
      for (const task of tasks.values()) {
        if (task.status === "running" && !live.has(task.taskId)) {
          task.status = "stopped";
          task.endedAt = event.at;
        }
      }
    } else if (event.type === "result") {
      for (const task of tasks.values()) {
        if (task.status === "running") {
          task.status = "stopped";
          task.endedByTurn = true;
        }
      }
    }
  }
  const list = [...tasks.values()];
  return list.length > MAX_TASKS ? list.slice(list.length - MAX_TASKS) : list;
}
