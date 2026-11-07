import { describe, expect, test } from "bun:test";
import type { ChangedFile, Hunk } from "../src/client/lib/api";
import {
  breadcrumbs,
  diffRows,
  formatSize,
  joinPath,
  parentPath,
  shouldRefreshChanges,
  splitLines,
  statusLabel,
  totalStats,
  type ChangesMarker,
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
      diffRows({ header: "@@ -1,0 +1,0 @@", oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }),
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

  test("tab asing kembali ke Perubahan", () => {
    expect(parsePanelPrefs('{"open":true,"tab":"entah"}')).toEqual({ open: true, tab: "changes" });
  });
});
