import { describe, expect, test } from "bun:test";
import type { CheckpointItem } from "../src/client/lib/api";
import {
  actionLabel,
  actionMark,
  canRewind,
  checkpointTitle,
  formatCheckpointTime,
  kindLabel,
  previewSummary,
  rewindBlockedReason,
  rewindSummary,
  validateLabel,
} from "../src/client/lib/checkpoints";

const NOW = new Date("2026-11-08T12:00:00.000Z");

function item(patch: Partial<CheckpointItem> = {}): CheckpointItem {
  return {
    id: "a".repeat(40),
    kind: "turn",
    turn: 3,
    label: "Giliran 3",
    createdAt: "2026-11-08T11:30:00.000Z",
    files: 2,
    ...patch,
  };
}

describe("checkpointTitle", () => {
  test("titik giliran memakai nomor giliran", () => {
    expect(checkpointTitle(item())).toBe("Giliran 3");
    expect(checkpointTitle(item({ turn: 0 }))).toBe("Giliran 0");
  });

  test("label manual dipakai apa adanya", () => {
    expect(checkpointTitle(item({ kind: "manual", turn: undefined, label: "sebelum refactor" }))).toBe(
      "sebelum refactor",
    );
  });

  test("label kosong jatuh ke bawaan per jenis", () => {
    expect(checkpointTitle(item({ kind: "manual", turn: undefined, label: "  " }))).toBe(
      "Titik manual",
    );
    expect(checkpointTitle(item({ kind: "pre-rewind", turn: undefined, label: "" }))).toBe(
      "Sebelum rewind",
    );
    expect(checkpointTitle(item({ kind: "turn", turn: undefined, label: "" }))).toBe("Titik");
  });

  test("label pengaman rewind panjang ditampilkan utuh", () => {
    expect(
      checkpointTitle(
        item({ kind: "pre-rewind", turn: undefined, label: "Sebelum rewind ke sebelum refactor" }),
      ),
    ).toBe("Sebelum rewind ke sebelum refactor");
  });
});

describe("kindLabel dan actionLabel", () => {
  test("jenis titik", () => {
    expect(kindLabel("turn")).toBe("Otomatis");
    expect(kindLabel("manual")).toBe("Manual");
    expect(kindLabel("pre-rewind")).toBe("Pengaman rewind");
  });

  test("aksi berkas", () => {
    expect(actionLabel("restore")).toBe("Dipulihkan");
    expect(actionLabel("recreate")).toBe("Dibuat ulang");
    expect(actionLabel("remove")).toBe("Dihapus");
  });

  test("huruf aksi mono", () => {
    expect(actionMark("restore")).toBe("P");
    expect(actionMark("recreate")).toBe("B");
    expect(actionMark("remove")).toBe("H");
  });
});

describe("previewSummary", () => {
  test("ringkasan campuran berurutan pulihkan, buat ulang, hapus", () => {
    expect(
      previewSummary({
        changes: [
          { path: "a", action: "remove" },
          { path: "b", action: "restore" },
          { path: "c", action: "recreate" },
          { path: "d", action: "restore" },
        ],
        truncated: false,
      }),
    ).toBe("2 dipulihkan · 1 dibuat ulang · 1 dihapus");
  });

  test("satu jenis saja", () => {
    expect(previewSummary({ changes: [{ path: "a", action: "remove" }], truncated: false })).toBe(
      "1 dihapus",
    );
  });

  test("nol perubahan", () => {
    expect(previewSummary({ changes: [], truncated: false })).toBe(
      "Tidak ada perubahan: folder sudah sama dengan titik ini.",
    );
  });
});

describe("rewindSummary", () => {
  test("ringkasan hasil rewind", () => {
    expect(rewindSummary({ safetyId: "x", restored: 1, recreated: 1, removed: 3 })).toBe(
      "1 dipulihkan · 1 dibuat ulang · 3 dihapus",
    );
  });

  test("tidak ada berkas berubah", () => {
    expect(rewindSummary({ safetyId: "x", restored: 0, recreated: 0, removed: 0 })).toBe(
      "Tidak ada berkas yang diubah.",
    );
  });
});

describe("canRewind dan rewindBlockedReason", () => {
  test("sesi berjalan diblokir", () => {
    expect(canRewind("berjalan")).toBe(false);
    expect(rewindBlockedReason("berjalan")).toBe(
      "Sesi sedang berjalan. Tunggu selesai atau hentikan dulu.",
    );
  });

  test("status lain boleh", () => {
    expect(canRewind("selesai")).toBe(true);
    expect(canRewind("gagal")).toBe(true);
    expect(canRewind("")).toBe(true);
    expect(rewindBlockedReason("selesai")).toBeUndefined();
  });
});

describe("validateLabel", () => {
  test("kosong dan spasi berarti label otomatis", () => {
    expect(validateLabel("")).toBeUndefined();
    expect(validateLabel("   ")).toBeUndefined();
  });

  test("panjang 1 sampai 80 diterima", () => {
    expect(validateLabel("a")).toBeUndefined();
    expect(validateLabel("a".repeat(80))).toBeUndefined();
  });

  test("81 karakter ditolak", () => {
    expect(validateLabel("a".repeat(81))).toBe("Label maksimal 80 karakter.");
  });

  test("karakter kontrol ditolak", () => {
    expect(validateLabel("a\nb")).toBe("Label tidak boleh memuat karakter kontrol.");
    expect(validateLabel("a\u0000b")).toBe("Label tidak boleh memuat karakter kontrol.");
    expect(validateLabel("a\u007fb")).toBe("Label tidak boleh memuat karakter kontrol.");
  });

  test("spasi di tepi tidak dihitung untuk batas", () => {
    expect(validateLabel(` ${"a".repeat(80)} `)).toBeUndefined();
  });
});

describe("formatCheckpointTime", () => {
  test("memakai format relatif", () => {
    expect(formatCheckpointTime("2026-11-08T11:59:30.000Z", NOW)).toBe("baru saja");
    expect(formatCheckpointTime("2026-11-08T11:30:00.000Z", NOW)).toBe("30 mnt lalu");
  });

  test("tanggal rusak menjadi kosong", () => {
    expect(formatCheckpointTime("bukan tanggal", NOW)).toBe("");
  });
});
