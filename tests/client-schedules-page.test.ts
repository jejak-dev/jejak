import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { SchedulesPage } from "../src/client/components/SchedulesPage";
import {
  ApiError,
  type ApiClient,
  type ScheduleCreateInput,
  type SchedulePatch,
  type ScheduledTask,
} from "../src/client/lib/api";
import {
  asElement,
  FakeNode,
  find,
  findByAttr,
  fire,
  flushEffects,
  installDom,
  mount,
} from "./helpers/dom";

let bersihkan: (() => void) | undefined;

beforeAll(() => {
  bersihkan = installDom();
  // ConfirmDialog memakai `HTMLElement` dan `document.body` saat modal dibuka.
  const globals = globalThis as Record<string, unknown>;
  globals["HTMLElement"] = FakeNode;
  const doc = globals["document"] as { body?: FakeNode };
  doc.body = asElement(new FakeNode("body"));
});

afterAll(() => {
  bersihkan?.();
});

/* ---------- Data bantu ---------- */

const TUGAS: ScheduledTask = {
  id: "t1",
  name: "Ringkasan harian",
  input: { prompt: "Ringkas repo", cwd: "/tmp/proyek" },
  spec: { kind: "daily", time: "09:00" },
  enabled: true,
  nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  lastRunAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  lastStatus: "ok",
  lastSessionId: "s1",
  runCount: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-16T09:00:00.000Z",
};

interface Panggilan {
  nama: string;
  argumen: unknown[];
}

/** Klien API tiruan: hanya metode yang dipakai halaman tugas. */
function apiPalsu(
  daftar: Panggilan[],
  tugas: ScheduledTask[] = [],
  galat?: unknown,
): ApiClient {
  const base = {
    listSchedules: async (): Promise<ScheduledTask[]> => {
      daftar.push({ nama: "listSchedules", argumen: [] });
      return tugas;
    },
    createSchedule: async (input: ScheduleCreateInput): Promise<ScheduledTask> => {
      daftar.push({ nama: "createSchedule", argumen: [input] });
      return TUGAS;
    },
    updateSchedule: async (id: string, patch: SchedulePatch): Promise<ScheduledTask> => {
      daftar.push({ nama: "updateSchedule", argumen: [id, patch] });
      return TUGAS;
    },
    deleteSchedule: async (id: string): Promise<void> => {
      daftar.push({ nama: "deleteSchedule", argumen: [id] });
    },
    runSchedule: async (id: string): Promise<ScheduledTask> => {
      daftar.push({ nama: "runSchedule", argumen: [id] });
      if (galat !== undefined) throw galat;
      return TUGAS;
    },
  };
  return base as unknown as ApiClient;
}

/** Elemen pertama yang teksnya memuat `teks`. */
function cariTeks(root: FakeNode, teks: string): FakeNode | undefined {
  return find(root, (node) => (node.textContent ?? "").includes(teks));
}

/** Tombol pertama yang teksnya memuat `teks`. */
function tombol(root: FakeNode, teks: string): FakeNode | undefined {
  return find(
    root,
    (node) => node.localName === "button" && (node.textContent ?? "").includes(teks),
  );
}

/**
 * Isi kolom teks lalu picu peristiwa input.
 *
 * Eachian wajib menunggu render berikutnya: state formulir diperbarui
 * dari nilai `form` terakhir, jadi dua isian tanpa jeda menimpa satu
 * sama lain.
 */
async function isi(root: FakeNode, id: string, teks: string): Promise<void> {
  const elemen = findByAttr(root, "id", id);
  expect(elemen).toBeDefined();
  (elemen as unknown as { value: string }).value = teks;
  fire(elemen!, "input");
  await flushEffects();
}

/** Pilih radio dengan nilai `nilai`. */
async function pilihRadio(root: FakeNode, name: string, nilai: string): Promise<void> {
  const elemen = find(
    root,
    (node) => node.localName === "input" && node.getAttribute("name") === name && node.getAttribute("value") === nilai,
  );
  expect(elemen).toBeDefined();
  fire(elemen!, "change");
  await flushEffects();
}

async function renderHalaman(
  api: ApiClient,
  defaultCwd?: string,
): Promise<FakeNode> {
  const root = mount(h(SchedulesPage, { api, defaultCwd }));
  await flushEffects();
  return root;
}

/* ---------- Tes ---------- */

describe("SchedulesPage", () => {
  test("daftar kosong menampilkan catatan", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar));

    expect(cariTeks(root, "Belum ada tugas terjadwal.")).toBeDefined();
    expect(cariTeks(root, TUGAS.name)).toBeUndefined();
  });

  test("keadaan kosong punya tombol Buat tugas pertama yang membuka form", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar));

    const tombolBuat = tombol(root, "Buat tugas pertama");
    expect(tombolBuat).toBeDefined();
    fire(tombolBuat!, "click");
    await flushEffects();

    const form = find(root, (node) => node.localName === "form");
    expect(form).toBeDefined();
    expect(findByAttr(root, "id", "jk-schedule-name")).toBeDefined();
  });

  test("baris menampilkan jadwal, status, dan tautan sesi terakhir", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar, [TUGAS]));

    expect(cariTeks(root, "Ringkasan harian")).toBeDefined();
    expect(cariTeks(root, "Harian 09:00")).toBeDefined();
    expect(cariTeks(root, "OK")).toBeDefined();
    expect(cariTeks(root, "Berjalan 3 kali")).toBeDefined();
    const tautan = find(root, (node) => node.getAttribute("href") === "#/s/s1");
    expect(tautan).toBeDefined();
  });

  test("saklar memanggil updateSchedule dengan enabled", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar, [TUGAS]));

    const saklar = findByAttr(root, "aria-label", "Nonaktifkan tugas Ringkasan harian");
    expect(saklar).toBeDefined();
    fire(saklar!, "click");
    await flushEffects();

    const panggilan = daftar.find((item) => item.nama === "updateSchedule");
    expect(panggilan?.argumen[0]).toBe("t1");
    expect(panggilan?.argumen[1]).toEqual({ enabled: false });
  });

  test("Jalankan sekarang memanggil runSchedule", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar, [TUGAS]));

    const tombolJalankan = findByAttr(root, "aria-label", "Jalankan tugas Ringkasan harian sekarang");
    expect(tombolJalankan).toBeDefined();
    fire(tombolJalankan!, "click");
    await flushEffects();

    const panggilan = daftar.find((item) => item.nama === "runSchedule");
    expect(panggilan?.argumen[0]).toBe("t1");
  });

  test("konflik saat menjalankan ditampilkan sebagai pesan", async () => {
    const daftar: Panggilan[] = [];
    const galat = new ApiError("Tugas sedang berjalan.", 409);
    const root = await renderHalaman(apiPalsu(daftar, [TUGAS], galat));

    const tombolJalankan = findByAttr(root, "aria-label", "Jalankan tugas Ringkasan harian sekarang");
    fire(tombolJalankan!, "click");
    await flushEffects();

    const pesan = cariTeks(root, "Tugas sedang berjalan.");
    expect(pesan).toBeDefined();
  });

  test("form membuat tugas dengan spec benar", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar), "/tmp/proyek");

    fire(tombol(root, "Tugas baru")!, "click");
    await flushEffects();

    await isi(root, "jk-schedule-name", "Tugas uji");
    await isi(root, "jk-schedule-prompt", "Kerjakan laporan");
    await isi(root, "jk-schedule-time", "07:30");
    // Pilih hari Senin.
    fire(findByAttr(root, "aria-label", "Senin")!, "click");
    await flushEffects();

    const form = find(root, (node) => node.localName === "form");
    expect(form).toBeDefined();
    fire(form!, "submit");
    await flushEffects();

    const panggilan = daftar.find((item) => item.nama === "createSchedule");
    expect(panggilan).toBeDefined();
    expect(panggilan?.argumen[0]).toEqual({
      name: "Tugas uji",
      spec: { kind: "daily", time: "07:30", days: [1] },
      prompt: "Kerjakan laporan",
      cwd: "/tmp/proyek",
      permissionMode: "default",
    });
  });

  test("jadwal sekali memakai datetime-local dan menolak waktu lampau", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar));

    fire(tombol(root, "Tugas baru")!, "click");
    await flushEffects();

    await isi(root, "jk-schedule-name", "Tugas sekali");
    await isi(root, "jk-schedule-prompt", "Kerjakan sekali");
    await pilihRadio(root, "jk-schedule-kind", "once");

    await isi(root, "jk-schedule-at", "2020-01-01T09:00");
    const form = find(root, (node) => node.localName === "form");
    fire(form!, "submit");
    await flushEffects();

    expect(daftar.find((item) => item.nama === "createSchedule")).toBeUndefined();
    expect(cariTeks(root, "masa depan")).toBeDefined();
  });

  test("mode tanpa izin tak ditawarkan", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar));

    fire(tombol(root, "Tugas baru")!, "click");
    await flushEffects();

    const isiForm = root.textContent ?? "";
    expect(isiForm).not.toContain("bypass");
    expect(isiForm.toLowerCase()).not.toContain("tanpa izin");

    const nilaiIzin = findAllNilai(root, "jk-schedule-mode");
    expect(nilaiIzin).toEqual(["default", "acceptEdits", "plan"]);
  });

  test("tombol hapus tersedia dan memakai konfirmasi", async () => {
    const daftar: Panggilan[] = [];
    const root = await renderHalaman(apiPalsu(daftar, [TUGAS]));

    const tombolHapus = findByAttr(root, "aria-label", "Hapus tugas Ringkasan harian");
    expect(tombolHapus).toBeDefined();
    fire(tombolHapus!, "click");
    await flushEffects();

    expect(cariTeks(root, "Hapus tugas?")).toBeDefined();
  });
});

/** Nilai radio dalam satu kelompok. */
function findAllNilai(root: FakeNode, name: string): string[] {
  const hasil: string[] = [];
  const walk = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.localName === "input" && child.getAttribute("name") === name) {
        hasil.push(child.getAttribute("value") ?? "");
      }
      walk(child);
    }
  };
  walk(root);
  return hasil;
}
