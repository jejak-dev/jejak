import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type SchedulePermissionMode,
  type ScheduledTask,
} from "../lib/api";
import { formatRelative } from "../lib/format";
import {
  DEFAULT_DAILY_TIME,
  DEFAULT_EVERY_MINUTES,
  describeNext,
  describeSpec,
  formToSpec,
  HARI_PENUH,
  HARI_SINGKAT,
  specToForm,
  type ScheduleFormValues,
  type ScheduleKind,
} from "../lib/schedule";
import { ConfirmDialog } from "./ConfirmDialog";

export interface SchedulesPageProps {
  api: ApiClient;
  /** Folder kerja bawaan untuk tugas baru. */
  defaultCwd?: string;
  /** Folder kerja yang pernah dipakai; ditawarkan sebagai saran. */
  recentCwds?: string[];
}

/** Mode izin yang boleh dipilih; bypass tak pernah ditawarkan. */
const PERMISSION_OPTIONS: { value: SchedulePermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Terima perubahan" },
  { value: "plan", label: "Rencana" },
];

const KIND_OPTIONS: { value: ScheduleKind; label: string }[] = [
  { value: "once", label: "Sekali" },
  { value: "every", label: "Berulang" },
  { value: "daily", label: "Harian" },
];

/** State formulir satu tugas: bagian sesi dan bagian jadwal. */
interface TaskForm {
  name: string;
  prompt: string;
  cwd: string;
  permissionMode: SchedulePermissionMode;
  schedule: ScheduleFormValues;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "tugas terjadwal tidak dapat dimuat";
}

/** Mode izin dari tugas yang tersimpan; bypass di luar jangkauan. */
function modeFromTask(task: ScheduledTask): SchedulePermissionMode {
  const mode = task.input.permissionMode;
  if (mode === "acceptEdits" || mode === "plan") return mode;
  return "default";
}

/** Ringkasan hasil jalannya terakhir. */
function statusLabel(task: ScheduledTask): string {
  if (task.lastStatus === "ok") return "OK";
  if (task.lastStatus === "gagal") {
    return `Gagal: ${task.lastError ?? "tanpa keterangan"}`;
  }
  return "Belum pernah berjalan";
}

export function SchedulesPage({ api, defaultCwd, recentCwds = [] }: SchedulesPageProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const [form, setForm] = useState<TaskForm | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [failures, setFailures] = useState<Record<string, string | undefined>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);

  const requestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const focusNameRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    requestRef.current += 1;
    const ticket = requestRef.current;
    try {
      const payload = await api.listSchedules();
      if (ticket !== requestRef.current) return;
      setTasks(payload);
      setLoadError(undefined);
    } catch (caught) {
      if (ticket !== requestRef.current) return;
      setLoadError(errorMessage(caught));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Muat ulang berkala selagi halaman terlihat.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!focusNameRef.current) return;
    focusNameRef.current = false;
    nameRef.current?.focus();
  }, [form]);

  const now = new Date();

  const suggestions = useMemo(() => {
    const seen: string[] = [];
    for (const path of [defaultCwd ?? "", ...recentCwds]) {
      if (path === "" || seen.includes(path)) continue;
      seen.push(path);
    }
    return seen.slice(0, 5);
  }, [defaultCwd, recentCwds]);

  const openCreate = (): void => {
    setEditingId(undefined);
    setFormError(undefined);
    setForm({
      name: "",
      prompt: "",
      cwd: defaultCwd ?? "",
      permissionMode: "default",
      schedule: {
        kind: "daily",
        at: "",
        everyMinutes: String(DEFAULT_EVERY_MINUTES),
        time: DEFAULT_DAILY_TIME,
        days: [],
      },
    });
    focusNameRef.current = true;
  };

  const openEdit = (task: ScheduledTask): void => {
    setEditingId(task.id);
    setFormError(undefined);
    setForm({
      name: task.name,
      prompt: task.input.prompt ?? "",
      cwd: task.input.cwd ?? "",
      permissionMode: modeFromTask(task),
      schedule: specToForm(task.spec),
    });
    focusNameRef.current = true;
  };

  const closeForm = (): void => {
    setForm(undefined);
    setEditingId(undefined);
    setFormError(undefined);
  };

  const runAction = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    if (busyId !== undefined) return;
    setBusyId(id);
    setFailures((current) => ({ ...current, [id]: undefined }));
    try {
      await action();
      await load();
    } catch (caught) {
      setFailures((current) => ({ ...current, [id]: errorMessage(caught) }));
    } finally {
      setBusyId(undefined);
    }
  };

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (form === undefined || saving) return;
    const name = form.name.trim();
    if (name === "") {
      setFormError("Nama tugas wajib diisi.");
      return;
    }
    const prompt = form.prompt.trim();
    if (prompt === "") {
      setFormError("Prompt wajib diisi.");
      return;
    }
    const spec = formToSpec(form.schedule, now);
    if (!spec.ok) {
      setFormError(spec.error);
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      if (editingId !== undefined) {
        await api.updateSchedule(editingId, {
          name,
          spec: spec.spec,
          prompt,
          cwd: form.cwd.trim(),
          permissionMode: form.permissionMode,
        });
      } else {
        await api.createSchedule({
          name,
          spec: spec.spec,
          prompt,
          cwd: form.cwd.trim(),
          permissionMode: form.permissionMode,
        });
      }
      closeForm();
      await load();
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (day: number): void => {
    if (form === undefined) return;
    const days = form.schedule.days.includes(day)
      ? form.schedule.days.filter((item) => item !== day)
      : [...form.schedule.days, day].sort((a, b) => a - b);
    setForm({ ...form, schedule: { ...form.schedule, days } });
  };

  return (
    <section class="jk-schedules" aria-labelledby="jk-schedules-title">
      <header class="jk-settings-head jk-head-row">
        <div class="jk-head-text">
          <h2
            id="jk-schedules-title"
            ref={headingRef}
            tabIndex={-1}
            class="jk-settings-title"
          >
            Jadwal
          </h2>
          <p class="jk-privacy-note">
            Prompt yang dijalankan otomatis sebagai sesi baru saat waktunya tiba.
          </p>
        </div>
        <button
          type="button"
          class="jk-button jk-head-action"
          aria-expanded={form !== undefined && editingId === undefined}
          onClick={openCreate}
        >
          Tugas baru
        </button>
      </header>

      {form !== undefined && (
        <form class="jk-schedules-form" onSubmit={(event) => void submit(event)} aria-busy={saving}>
          <div class="jk-schedules-form-head">
            <span class="jk-label">
              {editingId !== undefined ? "Sunting tugas" : "Tugas baru"}
            </span>
          </div>

          <div class="jk-field">
            <label class="jk-label" for="jk-schedule-name">
              Nama tugas
            </label>
            <input
              id="jk-schedule-name"
              ref={nameRef}
              class="jk-input"
              type="text"
              value={form.name}
              maxLength={80}
              autoComplete="off"
              onInput={(event) =>
                setForm({ ...form, name: (event.currentTarget as HTMLInputElement).value })
              }
            />
          </div>

          <div class="jk-field">
            <label class="jk-label" for="jk-schedule-prompt">
              Prompt
            </label>
            <textarea
              id="jk-schedule-prompt"
              class="jk-textarea"
              rows={4}
              value={form.prompt}
              onInput={(event) =>
                setForm({ ...form, prompt: (event.currentTarget as HTMLTextAreaElement).value })
              }
            />
          </div>

          <div class="jk-field">
            <label class="jk-label" for="jk-schedule-cwd">
              Folder kerja
            </label>
            <input
              id="jk-schedule-cwd"
              class="jk-input jk-input-code"
              type="text"
              value={form.cwd}
              autoComplete="off"
              onInput={(event) =>
                setForm({ ...form, cwd: (event.currentTarget as HTMLInputElement).value })
              }
            />
            {suggestions.length > 0 && (
              <div class="jk-schedules-suggestions">
                {suggestions.map((path) => (
                  <button
                    key={path}
                    type="button"
                    class="jk-link-btn"
                    onClick={() => setForm({ ...form, cwd: path })}
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div class="jk-field">
            <span class="jk-label">Mode izin</span>
            <div class="jk-radio-group">
              {PERMISSION_OPTIONS.map((option) => (
                <label class="jk-radio" key={option.value}>
                  <input
                    type="radio"
                    name="jk-schedule-mode"
                    value={option.value}
                    checked={form.permissionMode === option.value}
                    onChange={() =>
                      setForm({ ...form, permissionMode: option.value })
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div class="jk-field">
            <span class="jk-label">Jenis jadwal</span>
            <div class="jk-radio-group">
              {KIND_OPTIONS.map((option) => (
                <label class="jk-radio" key={option.value}>
                  <input
                    type="radio"
                    name="jk-schedule-kind"
                    value={option.value}
                    checked={form.schedule.kind === option.value}
                    onChange={() =>
                      setForm({
                        ...form,
                        schedule: { ...form.schedule, kind: option.value },
                      })
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>

          {form.schedule.kind === "once" && (
            <div class="jk-field">
              <label class="jk-label" for="jk-schedule-at">
                Waktu jalan
              </label>
              <input
                id="jk-schedule-at"
                class="jk-input"
                type="datetime-local"
                value={form.schedule.at}
                onInput={(event) =>
                  setForm({
                    ...form,
                    schedule: {
                      ...form.schedule,
                      at: (event.currentTarget as HTMLInputElement).value,
                    },
                  })
                }
              />
            </div>
          )}

          {form.schedule.kind === "every" && (
            <div class="jk-field">
              <label class="jk-label" for="jk-schedule-every">
                Interval (menit)
              </label>
              <input
                id="jk-schedule-every"
                class="jk-input"
                type="number"
                min={5}
                max={10080}
                step={1}
                value={form.schedule.everyMinutes}
                onInput={(event) =>
                  setForm({
                    ...form,
                    schedule: {
                      ...form.schedule,
                      everyMinutes: (event.currentTarget as HTMLInputElement).value,
                    },
                  })
                }
              />
            </div>
          )}

          {form.schedule.kind === "daily" && (
            <>
              <div class="jk-field">
                <label class="jk-label" for="jk-schedule-time">
                  Jam
                </label>
                <input
                  id="jk-schedule-time"
                  class="jk-input"
                  type="time"
                  value={form.schedule.time}
                  onInput={(event) =>
                    setForm({
                      ...form,
                      schedule: {
                        ...form.schedule,
                        time: (event.currentTarget as HTMLInputElement).value,
                      },
                    })
                  }
                />
              </div>
              <div class="jk-field">
                <span class="jk-label">Hari</span>
                <div class="jk-schedules-days" role="group" aria-label="Hari yang dijalankan">
                  {HARI_SINGKAT.map((label, day) => (
                    <button
                      key={day}
                      type="button"
                      class={`jk-schedules-day${
                        form.schedule.days.includes(day) ? " jk-schedules-day-on" : ""
                      }`}
                      aria-pressed={form.schedule.days.includes(day)}
                      aria-label={HARI_PENUH[day]}
                      onClick={() => toggleDay(day)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {formError !== undefined && (
            <p class="jk-error-line" role="alert">
              {formError}
            </p>
          )}

          <div class="jk-form-actions">
            <button type="submit" class="jk-button jk-button-primary" disabled={saving}>
              {saving ? "Menyimpan…" : "Simpan"}
            </button>
            <button type="button" class="jk-button" disabled={saving} onClick={closeForm}>
              Batal
            </button>
          </div>
        </form>
      )}

      {loading && <p class="jk-note">Memuat…</p>}

      {loadError !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {loadError}
          </p>
          <button type="button" class="jk-link-btn" onClick={() => void load()}>
            Coba lagi
          </button>
        </div>
      )}

      {!loading && loadError === undefined && tasks.length === 0 && (
        <div class="jk-empty-state jk-schedules-empty">
          <p class="jk-note">Belum ada tugas terjadwal.</p>
          <p class="jk-note">
            Buat tugas untuk menjalankan prompt otomatis, misalnya ringkasan harian atau pemeriksaan
            mingguan.
          </p>
          {form === undefined && (
            <button type="button" class="jk-button" onClick={openCreate}>
              Buat tugas pertama
            </button>
          )}
        </div>
      )}

      {tasks.length > 0 && (
        <ul class="jk-schedules-list">
          {tasks.map((task) => {
            const busy = busyId === task.id;
            const failure = failures[task.id];
            return (
              <li class="jk-schedules-row" key={task.id}>
                <div class="jk-schedules-row-head">
                  <span class="jk-schedules-name">{task.name}</span>
                  <span class="jk-badge jk-badge-muted">{describeSpec(task.spec)}</span>
                  <span class="jk-schedules-next">{describeNext(task, now)}</span>
                  <button
                    type="button"
                    class="jk-link-btn jk-schedules-switch"
                    disabled={busyId !== undefined}
                    aria-pressed={task.enabled}
                    aria-label={`${task.enabled ? "Nonaktifkan" : "Aktifkan"} tugas ${task.name}`}
                    onClick={() =>
                      void runAction(task.id, () =>
                        api.updateSchedule(task.id, { enabled: !task.enabled }),
                      )
                    }
                  >
                    {task.enabled ? "Aktif" : "Nonaktif"}
                  </button>
                </div>

                <div class="jk-schedules-row-body">
                  <p class="jk-schedules-status">
                    {statusLabel(task)}
                    {task.lastRunAt !== undefined && (
                      <span class="jk-schedules-time"> · {formatRelative(task.lastRunAt, now)}</span>
                    )}
                    {task.lastSessionId !== undefined && (
                      <>
                        {" · "}
                        <a class="jk-link-btn" href={`#/s/${task.lastSessionId}`}>
                          Lihat sesi
                        </a>
                      </>
                    )}
                  </p>
                  <p class="jk-schedules-count">Berjalan {task.runCount} kali</p>

                  {failure !== undefined && (
                    <p class="jk-error-line" role="alert">
                      {failure}
                    </p>
                  )}

                  <div class="jk-schedules-actions">
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busyId !== undefined}
                      aria-label={`Jalankan tugas ${task.name} sekarang`}
                      onClick={() => void runAction(task.id, () => api.runSchedule(task.id))}
                    >
                      {busy ? "Menjalankan…" : "Jalankan sekarang"}
                    </button>
                    <button
                      type="button"
                      class="jk-link-btn"
                      disabled={busyId !== undefined}
                      aria-label={`Ubah tugas ${task.name}`}
                      onClick={() => openEdit(task)}
                    >
                      Ubah
                    </button>
                    <button
                      type="button"
                      class="jk-link-btn jk-schedules-danger"
                      disabled={busyId !== undefined}
                      aria-label={`Hapus tugas ${task.name}`}
                      onClick={() => setConfirmDeleteId(task.id)}
                    >
                      Hapus
                    </button>
                  </div>
                </div>

                <ConfirmDialog
                  open={confirmDeleteId === task.id}
                  title="Hapus tugas?"
                  message={`Tugas ${task.name} akan dihapus beserta jadwalnya.`}
                  confirmLabel="Ya"
                  busyLabel="Menghapus…"
                  tone="danger"
                  busy={busy}
                  confirmAriaLabel={`Konfirmasi hapus tugas ${task.name}`}
                  cancelAriaLabel={`Batal menghapus tugas ${task.name}`}
                  onConfirm={() => {
                    setConfirmDeleteId(undefined);
                    void runAction(task.id, () => api.deleteSchedule(task.id));
                  }}
                  onCancel={() => setConfirmDeleteId(undefined)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
