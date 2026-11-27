import { useEffect, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import {
  backgroundKindLabel,
  backgroundStatusLabel,
  formatElapsed,
  groupBackgroundTasks,
  type BackgroundTask,
} from "../lib/background-tasks";

export interface TasksTabProps {
  api: ApiClient;
  sessionId: string;
  /** Status sesi; tombol berhenti hanya aktif saat "berjalan". */
  status: string;
  tasks: readonly BackgroundTask[];
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "terjadi kesalahan";
}

/**
 * Tab "Tugas latar": tugas berjalan (Bash latar, Monitor, subagent) dengan lama
 * berjalan dan tombol berhenti, serta bagian terlipat untuk yang selesai.
 *
 * Proses CLI ditutup di akhir tiap giliran sehingga tugas latar tidak bertahan
 * lintas giliran; tugas yang tersisa ditandai "dihentikan saat giliran berakhir".
 */
export function TasksTab({ api, sessionId, status, tasks }: TasksTabProps) {
  const { running, finished, failed } = groupBackgroundTasks(tasks);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  const hentikan = async (taskId: string): Promise<void> => {
    if (busy !== undefined) return;
    setBusy(taskId);
    setError(undefined);
    try {
      await api.stopBackgroundTask(sessionId, taskId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(undefined);
    }
  };

  if (tasks.length === 0) {
    return (
      <div class="jk-panel-body">
        <p class="jk-panel-note">Belum ada tugas latar belakang di sesi ini.</p>
      </div>
    );
  }

  return (
    <div class="jk-panel-body">
      <p class="jk-panel-note">Berjalan {running.length}</p>
      {running.length > 0 && (
        <ul class="jk-bgtask-list">
          {running.map((task) => (
            <li class="jk-bgtask" key={task.taskId}>
              <span class="jk-todo-dot jk-todo-dot-run" aria-hidden="true" />
              <span class="jk-bgtask-text">
                <span class="jk-bgtask-title">{task.description}</span>
                <span class="jk-bgtask-meta">
                  {task.kind !== undefined ? `${backgroundKindLabel(task.kind)} · ` : ""}
                  {formatElapsed(now - task.startedAt)}
                </span>
              </span>
              <button
                type="button"
                class="jk-btn jk-btn-sm"
                disabled={busy !== undefined || status !== "berjalan"}
                title={status === "berjalan" ? "Hentikan tugas ini" : "Hanya bisa saat giliran berjalan"}
                onClick={() => void hentikan(task.taskId)}
              >
                Berhenti
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <p class="jk-panel-note" role="alert">
          {error}
        </p>
      )}
      {finished.length > 0 && (
        <details class="jk-bgtask-done">
          <summary>
            Selesai {finished.length}
            {failed > 0 ? ` · ${failed} gagal` : ""}
          </summary>
          <ul class="jk-bgtask-list">
            {finished.map((task) => (
              <li class="jk-bgtask jk-bgtask-ended" key={task.taskId}>
                <span class="jk-bgtask-text">
                  <span class="jk-bgtask-title">{task.description}</span>
                  <span class="jk-bgtask-meta">
                    {backgroundStatusLabel(task)}
                    {task.summary !== undefined && task.summary !== task.description ? ` · ${task.summary}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
