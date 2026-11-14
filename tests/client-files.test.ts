import { describe, expect, test } from "bun:test";
import type { ChangedFile, Hunk } from "../src/client/lib/api";
import {
  breadcrumbs,
  canReject,
  diffRows,
  formatSize,
  joinPath,
  nextOpenPaths,
  parentPath,
  pushUndoLine,
  rejectBlockedReason,
  rejectConfirmContent,
  rejectTargetKey,
  removeUndoLine,
  shouldRefreshChanges,
  splitLines,
  statusLabel,
  totalStats,
  updateUndoLine,
  type ChangesMarker,
  type UndoLine,
} from "../src/client/lib/files";
import { parsePanelPrefs } from "../src/client/lib/panel-prefs";

describe("breadcrumbs", () => {
  test("akar memakai label folder kerja dan path kosong", () => {
    expect(breadcrumbs("")).toEqual([{ label: "folder kerja", path: "" }]);
  });

  test("path bersarang menyusun segmen dengan path kumulatif", () => {
    expect(breadcrumbs("src/client/lib")).toEqual([
      { label: "folder kerja", path: "" },
      { label: "src", path: "src" },
      { label: "client", path: "src/client" },
      { label: "lib", path: "src/client/lib" },
    ]);
  });

  test("abaikan segmen kosong dan garis miring berlebih", () => {
    expect(breadcrumbs("/a//b/")).toEqual([
      { label: "folder kerja", path: "" },
      { label: "a", path: "a" },
      { label: "b", path: "a/b" },
    ]);
  });

  test("nama berkas berspasi tetap satu label", () => {
    const crumbs = breadcrumbs("src/berkas baru.txt");
    expect(crumbs[2]).toEqual({ label: "berkas baru.txt", path: "src/berkas baru.txt" });
  });
});

describe("splitLines", () => {
  test("newline akhir tidak menambah baris kosong", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("tanpa newline akhir, baris terakhir tetap ditampilkan", () => {
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  test("konten kosong menjadi daftar kosong", () => {
    expect(splitLines("")).toEqual([]);
  });

  test("hanya newline berarti satu baris kosong", () => {
    expect(splitLines("\n")).toEqual([""]);
  });

  test("CRLF dinormalkan", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  test("hanya satu baris kosong terakhir yang dibuang", () => {
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
});

describe("parentPath", () => {
  test("akar dan berkas tingkat atas menjadi kosong", () => {
    expect(parentPath("")).toBe("");
    expect(parentPath("berkas.txt")).toBe("");
  });

  test("mengembalikan direktori induk", () => {
    expect(parentPath("src/client/lib/files.ts")).toBe("src/client/lib");
  });
});

describe("joinPath", () => {
  test("gabung tanpa memperbaiki garis miring ganda di akar", () => {
    expect(joinPath("", "src")).toBe("src");
    expect(joinPath("src", "client")).toBe("src/client");
    expect(joinPath("src/client", "a b.txt")).toBe("src/client/a b.txt");
  });
});

describe("formatSize", () => {
  test("bita kecil memakai satuan B", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(340)).toBe("340 B");
    expect(formatSize(1023)).toBe("1.023 B");
  });

  test("batas 1024 beralih ke KB dengan koma id-ID", () => {
    expect(formatSize(1024)).toBe("1,0 KB");
    expect(formatSize(1200)).toBe("1,2 KB");
  });

  test("batas 1 MB beralih ke MB", () => {
    expect(formatSize(1024 * 1024)).toBe("1,0 MB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2,0 MB");
  });

  test("ukuran tidak diketahui menjadi tanda hubung", () => {
    expect(formatSize(undefined)).toBe("–");
    expect(formatSize(Number.NaN)).toBe("–");
    expect(formatSize(-1)).toBe("–");
  });
});

describe("statusLabel", () => {
  test("memetakan setiap status git ke teks Bahasa Indonesia", () => {
    expect(statusLabel("M")).toBe("Diubah");
    expect(statusLabel("A")).toBe("Ditambah");
    expect(statusLabel("D")).toBe("Dihapus");
    expect(statusLabel("R")).toBe("Dipindah");
    expect(statusLabel("U")).toBe("Baru (belum dilacak)");
  });
});

describe("totalStats", () => {
  test("menjumlahkan tambahan dan penghapusan semua berkas", () => {
    const files = [
      { additions: 3, deletions: 1 },
      { additions: 10, deletions: 4 },
    ] as ChangedFile[];
    expect(totalStats(files)).toEqual({ additions: 13, deletions: 5 });
  });

  test("daftar kosong menjadi nol", () => {
    expect(totalStats([])).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("diffRows", () => {
  const hunk: Hunk = {
    id: "h1",
    header: "@@ -3,4 +3,5 @@",
    oldStart: 3,
    oldLines: 4,
    newStart: 3,
    newLines: 5,
    lines: [
      { t: "ctx", text: "sama" },
      { t: "del", text: "lama" },
      { t: "add", text: "baru" },
      { t: "add", text: "lagi" },
      { t: "ctx", text: "akhir" },
    ],
  };

  test("menomori baris lama dan baru sesuai posisi hunk", () => {
    expect(diffRows(hunk)).toEqual([
      { oldNo: 3, newNo: 3, t: "ctx", text: "sama" },
      { oldNo: 4, t: "del", text: "lama" },
      { newNo: 4, t: "add", text: "baru" },
      { newNo: 5, t: "add", text: "lagi" },
      { oldNo: 5, newNo: 6, t: "ctx", text: "akhir" },
    ]);
  });

  test("hunk kosong tidak menghasilkan baris", () => {
    expect(
      diffRows({
        id: "h2",
        header: "@@ -1,0 +1,0 @@",
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 0,
        lines: [],
      }),
    ).toEqual([]);
  });
});

describe("shouldRefreshChanges", () => {
  const base = { open: true, tab: "changes" as const, status: "berjalan", eventCount: 4 };

  test("panel tertutup atau tab lain tidak menyegarkan", () => {
    expect(shouldRefreshChanges({ ...base, open: false }, undefined)).toBe(false);
    expect(shouldRefreshChanges({ ...base, tab: "files" }, undefined)).toBe(false);
  });

  test("pemuatan pertama selalu berjalan", () => {
    expect(shouldRefreshChanges(base, undefined)).toBe(true);
  });

  test("berubah saat jumlah event atau status bergeser", () => {
    const marker: ChangesMarker = { status: "berjalan", eventCount: 4 };
    expect(shouldRefreshChanges(base, marker)).toBe(false);
    expect(shouldRefreshChanges({ ...base, eventCount: 5 }, marker)).toBe(true);
    expect(shouldRefreshChanges({ ...base, status: "selesai" }, marker)).toBe(true);
  });
});

describe("parsePanelPrefs", () => {
  test("nilai kosong atau rusak jatuh ke bawaan", () => {
    expect(parsePanelPrefs(null)).toEqual({ open: false, tab: "changes" });
    expect(parsePanelPrefs("")).toEqual({ open: false, tab: "changes" });
    expect(parsePanelPrefs("{rusak")).toEqual({ open: false, tab: "changes" });
    expect(parsePanelPrefs("[1,2]")).toEqual({ open: false, tab: "changes" });
  });

  test("membaca keadaan terbuka dan tab berkas", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"files"}')).toEqual({ open: true, tab: "files" });
  });

  test("membaca tab Titik", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"checkpoints"}')).toEqual({
      open: true,
      tab: "checkpoints",
    });
  });

  test("membaca tab Git", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"git"}')).toEqual({ open: true, tab: "git" });
    expect(parsePanelPrefs('{"open":false,"tab":"git"}')).toEqual({ open: false, tab: "git" });
  });

  test("membaca tab Rahasia", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"rahasia"}')).toEqual({
      open: true,
      tab: "rahasia",
    });
  });

  test("membaca tab Todos", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"todos"}')).toEqual({ open: true, tab: "todos" });
  });

  test("tab asing kembali ke Perubahan", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"entah"}')).toEqual({ open: true, tab: "changes" });
  });
});

function changedFile(patch: Partial<ChangedFile>): ChangedFile {
  return {
    path: "src/a.ts",
    status: "M",
    diffId: "a".repeat(64),
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [
      {
        id: "h".repeat(64),
        header: "@@ -1,1 +1,2 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [{ t: "add", text: "baru" }],
      },
    ],
    ...patch,
  };
}

describe("canReject", () => {
  test("berkas M dan D dengan hunk bisa ditolak", () => {
    expect(canReject(changedFile({ status: "M" }))).toBe(true);
    expect(canReject(changedFile({ status: "D" }))).toBe(true);
  });

  test("status A, U, dan R tidak bisa ditolak", () => {
    expect(canReject(changedFile({ status: "A" }))).toBe(false);
    expect(canReject(changedFile({ status: "U" }))).toBe(false);
    expect(canReject(changedFile({ status: "R" }))).toBe(false);
  });

  test("berkas biner tidak bisa ditolak", () => {
    expect(canReject(changedFile({ status: "M", binary: true }))).toBe(false);
  });

  test("berkas tanpa hunk tidak bisa ditolak", () => {
    expect(canReject(changedFile({ status: "M", hunks: [] }))).toBe(false);
  });
});

describe("rejectBlockedReason", () => {
  test("sesi berjalan memblokir walau berkas bisa ditolak", () => {
    expect(
      rejectBlockedReason({ sessionStatus: "berjalan", file: changedFile({ status: "M" }) }),
    ).toBe("Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.");
  });

  test("jenis perubahan tidak didukung memblokir", () => {
    expect(
      rejectBlockedReason({ sessionStatus: "selesai", file: changedFile({ status: "A" }) }),
    ).toBe("Jenis perubahan ini belum bisa ditolak.");
    expect(
      rejectBlockedReason({ sessionStatus: "selesai", file: changedFile({ binary: true }) }),
    ).toBe("Jenis perubahan ini belum bisa ditolak.");
  });

  test("sesi tidak berjalan dan berkas M/D tidak diblokir", () => {
    expect(
      rejectBlockedReason({ sessionStatus: "selesai", file: changedFile({ status: "D" }) }),
    ).toBeUndefined();
  });
});

describe("antrean baris urung", () => {
  const line = (undoId: string): UndoLine => ({ undoId, path: `${undoId}.txt` });

  test("baris baru di depan dan maksimal 5", () => {
    let lines: UndoLine[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      lines = pushUndoLine(lines, line(id));
    }
    expect(lines.map((item) => item.undoId)).toEqual(["f", "e", "d", "c", "b"]);
    expect(lines).toHaveLength(5);
  });

  test("hapus dan perbarui baris berdasarkan undoId", () => {
    const lines = [line("a"), line("b")];
    expect(removeUndoLine(lines, "a").map((item) => item.undoId)).toEqual(["b"]);
    expect(updateUndoLine(lines, "b", { error: "gagal" })).toEqual([
      line("a"),
      { undoId: "b", path: "b.txt", error: "gagal" },
    ]);
  });

  test("baris tak dikenal tidak berubah", () => {
    const lines = [line("a")];
    expect(removeUndoLine(lines, "x")).toEqual(lines);
    expect(updateUndoLine(lines, "x", { error: "gagal" })).toEqual(lines);
  });
});

describe("nextOpenPaths", () => {
  test("menambah dan menghapus path tanpa mengubah set lama", () => {
    const before = new Set(["a.txt"]);
    const opened = nextOpenPaths(before, "b.txt", true);
    expect([...opened].sort()).toEqual(["a.txt", "b.txt"]);
    expect([...before]).toEqual(["a.txt"]);

    const closed = nextOpenPaths(opened, "a.txt", false);
    expect([...closed]).toEqual(["b.txt"]);
  });
});

describe("rejectTargetKey", () => {
  test("hunk memakai path dan id; berkas hanya path", () => {
    expect(rejectTargetKey(undefined)).toBeUndefined();
    expect(rejectTargetKey({ path: "a.txt", scope: "file" })).toBe("a.txt");
    expect(rejectTargetKey({ path: "a.txt", scope: "hunk", hunkId: "h1" })).toBe("a.txt\0h1");
  });
});

describe("rejectConfirmContent", () => {
  test("tanpa target tidak ada isi modal", () => {
    expect(rejectConfirmContent(undefined, [])).toBeUndefined();
  });

  test("target berkas yang tidak ada di daftar tidak ada isi modal", () => {
    expect(
      rejectConfirmContent({ path: "lain.ts", scope: "file" }, [changedFile({})]),
    ).toBeUndefined();
  });

  test("scope berkas memakai pertanyaan seluruh berkas", () => {
    const content = rejectConfirmContent({ path: "src/a.ts", scope: "file" }, [changedFile({})]);
    expect(content?.title).toBe("Tolak seluruh berkas?");
    expect(content?.message).toContain("Kembalikan seluruh berkas ke versi HEAD?");
    expect(content?.confirmLabel).toBe("Tolak");
    expect(content?.confirmAriaLabel).toBe("Konfirmasi tolak seluruh berkas src/a.ts");
    expect(content?.cancelAriaLabel).toBe("Batal menolak seluruh berkas src/a.ts");
  });

  test("scope hunk memakai nomor hunk di dalam berkas", () => {
    const files = [
      changedFile({
        hunks: [
          { id: "h1", header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
          { id: "h2", header: "@@ -9 +9 @@", oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [] },
        ],
      }),
    ];
    const content = rejectConfirmContent({ path: "src/a.ts", scope: "hunk", hunkId: "h2" }, files);
    expect(content?.title).toBe("Tolak hunk?");
    expect(content?.message).toBe("Kembalikan hunk ini ke versi sebelumnya?");
    expect(content?.confirmAriaLabel).toBe("Konfirmasi tolak hunk 2 di src/a.ts");
    expect(content?.cancelAriaLabel).toBe("Batal menolak hunk 2 di src/a.ts");
  });
});
