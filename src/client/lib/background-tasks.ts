import type { BackgroundTask } from "../../server/agent/background-tasks";

export { foldBackgroundTasks, type BackgroundTask } from "../../server/agent/background-tasks";

/** Lama berjalan: "12 dtk", "3 mnt 5 dtk", "1 j 2 mnt". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} dtk`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} mnt ${total % 60} dtk`;
  return `${Math.floor(minutes / 60)} j ${minutes % 60} mnt`;
}

export interface BackgroundTaskGroups {
  running: BackgroundTask[];
  finished: BackgroundTask[];
  failed: number;
}

/** Pisahkan yang berjalan dari yang selesai; yang terbaru di atas. "Gagal" = status gagal. */
export function groupBackgroundTasks(tasks: readonly BackgroundTask[]): BackgroundTaskGroups {
  const running = tasks.filter((task) => task.status === "running");
  const finished = tasks.filter((task) => task.status !== "running").reverse();
  return {
    running,
    finished,
    failed: finished.filter((task) => task.status === "failed").length,
  };
}

/** Label status akhir untuk baris selesai. */
export function backgroundStatusLabel(task: BackgroundTask): string {
  if (task.status === "completed") return "selesai";
  if (task.status === "failed") return "gagal";
  if (task.status === "stopped") {
    return task.endedByTurn === true ? "dihentikan saat giliran berakhir" : "dihentikan";
  }
  return "berjalan";
}

/** Nama ramah untuk jenis tugas SDK; jenis asing dipakai apa adanya. */
export function backgroundKindLabel(kind: string): string {
  switch (kind) {
    case "local_bash":
      return "Bash";
    case "local_agent":
      return "Subagent";
    case "monitor":
    case "local_monitor":
      return "Monitor";
    case "local_workflow":
      return "Workflow";
    default:
      return kind;
  }
}
