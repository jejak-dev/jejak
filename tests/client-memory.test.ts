import { describe, expect, test } from "bun:test";
import type { MemoryImportResult, MemoryItem } from "../src/client/lib/api";
import {
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  canAccept,
  canArchive,
  canEdit,
  canReject,
  confidenceLabel,
  filterByLayer,
  groupSkipped,
  importSummary,
  layerLabel,
  memoryDateLabel,
  originLabel,
  projectLabel,
  skippedReasonLabel,
  staleLabel,
  statusLabel,
  validateDraft,
} from "../src/client/lib/memory";

function make(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "0f0e0d0c-0b0a-4f0e-8d0c-0b0a09080706",
    layer: "profile",
    projectKey: null,
    title: "Judul",
    body: "Isi",
    status: "active",
    confidence: "confirmed",
    origin: { kind: "manual", at: "2026-11-08T10:00:00.000Z" },
    staleReason: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    updatedAt: "2026-11-08T10:00:00.000Z",
    decidedAt: null,
    replaces: null,
    ...overrides,
  };
}

describe("layerLabel", () => {
  test("label Bahasa Indonesia", () => {
    expect(layerLabel("profile")).toBe("Profil");
    expect(layerLabel("project")).toBe("Proyek");
  });
});

describe("statusLabel", () => {
  test("label tiap status", () => {
    expect(statusLabel("proposed")).toBe("Usulan");
    expect(statusLabel("active")).toBe("Aktif");
    expect(statusLabel("rejected")).toBe("Ditolak");
    expect(statusLabel("archived")).toBe("Diarsipkan");
  });
});

describe("confidenceLabel", () => {
  test("label tiap tingkat kepercayaan", () => {
    expect(confidenceLabel("confirmed")).toBe("Dikonfirmasi");
    expect(confidenceLabel("from_code")).toBe("Dari kode");
    expect(confidenceLabel("inferred")).toBe("Kesimpulan agent");
  });
});

describe("originLabel", () => {
  test("manual menyertakan tanggal id-ID", () => {
    expect(originLabel({ kind: "manual", at: "2026-11-08T10:00:00.000Z" })).toBe(
      "Ditulis manual · 8 Nov 2026",
    );
  });

  test("manual dengan tanggal rusak tanpa bagian tanggal", () => {
    expect(originLabel({ kind: "manual", at: "bukan tanggal" })).toBe("Ditulis manual");
  });

  test("sesi dan berkas", () => {
    expect(originLabel({ kind: "session", at: "2026-11-08T10:00:00.000Z" })).toBe("Dari sesi");
    expect(
      originLabel({
        kind: "file",
        at: "2026-11-08T10:00:00.000Z",
        file: "src/x.ts",
        fileSha256: "a".repeat(64),
      }),
    ).toBe("Dari berkas src/x.ts");
  });

  test("file tanpa nama berkas jatuh ke label sesi", () => {
    expect(originLabel({ kind: "file", at: "2026-11-08T10:00:00.000Z" })).toBe("Dari sesi");
  });
});

describe("projectLabel", () => {
  test("nama folder terakhir dan null", () => {
    expect(projectLabel("/Users/boy/Developer/jejak")).toBe("jejak");
    expect(projectLabel(null)).toBe("Semua proyek");
    expect(projectLabel("")).toBe("Semua proyek");
  });
});

describe("memoryDateLabel", () => {
  test("tanggal id-ID dan tanggal rusak", () => {
    expect(memoryDateLabel("2026-11-08T10:00:00.000Z")).toBe("8 Nov 2026");
    expect(memoryDateLabel("bukan tanggal")).toBe("");
  });
});

describe("staleLabel", () => {
  test("null/kosong tidak menandai, alasan lain diberi awalan", () => {
    expect(staleLabel(null)).toBeUndefined();
    expect(staleLabel("")).toBeUndefined();
    expect(staleLabel("berkas asal berubah")).toBe("Mungkin basi: berkas asal berubah");
  });
});

describe("canX per status", () => {
  test("usulan: terima, ubah, tolak; bukan arsip", () => {
    expect(canAccept("proposed")).toBe(true);
    expect(canReject("proposed")).toBe(true);
    expect(canEdit("proposed")).toBe(true);
    expect(canArchive("proposed")).toBe(false);
  });

  test("aktif: ubah dan arsip; bukan terima/tolak", () => {
    expect(canAccept("active")).toBe(false);
    expect(canReject("active")).toBe(false);
    expect(canEdit("active")).toBe(true);
    expect(canArchive("active")).toBe(true);
  });

  test("ditolak dan diarsipkan: tidak ada aksi", () => {
    for (const status of ["rejected", "archived"] as const) {
      expect(canAccept(status)).toBe(false);
      expect(canReject(status)).toBe(false);
      expect(canEdit(status)).toBe(false);
      expect(canArchive(status)).toBe(false);
    }
  });
});

describe("validateDraft", () => {
  const base = { layer: "profile" as const, projectKey: "", title: "Judul", body: "Isi" };

  test("draf valid tidak menghasilkan galat", () => {
    expect(validateDraft(base)).toBeUndefined();
    expect(validateDraft({ ...base, layer: "project", projectKey: "/tmp/x" })).toBeUndefined();
  });

  test("judul kosong dan melewati batas", () => {
    expect(validateDraft({ ...base, title: "   " })).toBe(
      `Judul harus 1-${MEMORY_TITLE_MAX} karakter.`,
    );
    expect(validateDraft({ ...base, title: "a".repeat(MEMORY_TITLE_MAX) })).toBeUndefined();
    expect(validateDraft({ ...base, title: "a".repeat(MEMORY_TITLE_MAX + 1) })).toBe(
      `Judul harus 1-${MEMORY_TITLE_MAX} karakter.`,
    );
  });

  test("isi kosong dan melewati batas", () => {
    expect(validateDraft({ ...base, body: "  " })).toBe(
      `Isi harus 1-${MEMORY_BODY_MAX} karakter.`,
    );
    expect(validateDraft({ ...base, body: "a".repeat(MEMORY_BODY_MAX) })).toBeUndefined();
    expect(validateDraft({ ...base, body: "a".repeat(MEMORY_BODY_MAX + 1) })).toBe(
      `Isi harus 1-${MEMORY_BODY_MAX} karakter.`,
    );
  });

  test("lapis proyek wajib punya folder", () => {
    expect(validateDraft({ ...base, layer: "project", projectKey: "  " })).toBe(
      "Pilih folder proyek untuk memory lapis proyek.",
    );
  });
});

describe("filterByLayer", () => {
  const items = [
    make({ id: "a", layer: "profile" }),
    make({ id: "b", layer: "project", projectKey: "/tmp/x" }),
    make({ id: "c", layer: "profile" }),
  ];

  test("semua mengembalikan salinan penuh", () => {
    const result = filterByLayer(items, "semua");
    expect(result.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result).not.toBe(items);
  });

  test("menyaring per lapis", () => {
    expect(filterByLayer(items, "profile").map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterByLayer(items, "project").map((item) => item.id)).toEqual(["b"]);
  });

  test("daftar kosong", () => {
    expect(filterByLayer([], "profile")).toEqual([]);
  });
});

describe("skippedReasonLabel", () => {
  test("label tiap alasan", () => {
    expect(skippedReasonLabel("sudah-ada")).toBe("Sudah ada");
    expect(skippedReasonLabel("rahasia")).toBe("Memuat rahasia");
    expect(skippedReasonLabel("terlalu-panjang")).toBe("Terlalu panjang");
    expect(skippedReasonLabel("kosong")).toBe("Kosong");
    expect(skippedReasonLabel("batas")).toBe("Batas usulan tercapai");
  });
});

describe("groupSkipped", () => {
  test("menghitung per alasan tanpa alasan kosong, urut tetap", () => {
    const groups = groupSkipped([
      { file: "AGENTS.md", title: "A", reason: "sudah-ada" },
      { file: "AGENTS.md", title: "B", reason: "rahasia" },
      { file: "CLAUDE.md", title: "C", reason: "sudah-ada" },
      { file: "CLAUDE.md", title: "D", reason: "sudah-ada" },
    ]);

    expect(groups).toEqual([
      { reason: "sudah-ada", label: "Sudah ada", count: 3 },
      { reason: "rahasia", label: "Memuat rahasia", count: 1 },
    ]);
  });

  test("tanpa bagian yang dilewati menghasilkan daftar kosong", () => {
    expect(groupSkipped([])).toEqual([]);
  });
});

describe("importSummary", () => {
  const created = make({ title: "Baru" }) as MemoryImportResult["created"][number];

  function result(overrides: Partial<MemoryImportResult> = {}): MemoryImportResult {
    return {
      created: [],
      skipped: [],
      files: [
        { file: "AGENTS.md", found: true },
        { file: "CLAUDE.md", found: false },
      ],
      ...overrides,
    };
  }

  test("usulan baru menyebut berkas yang ditemukan", () => {
    expect(importSummary(result({ created: [created] }))).toBe(
      "1 usulan baru dari AGENTS.md.",
    );
  });

  test("beberapa berkas ditemukan disebut dengan dan", () => {
    expect(
      importSummary(
        result({
          created: [created],
          files: [
            { file: "AGENTS.md", found: true },
            { file: "CLAUDE.md", found: true },
          ],
        }),
      ),
    ).toBe("1 usulan baru dari AGENTS.md dan CLAUDE.md.");
  });

  test("semua sudah ada (0 baru)", () => {
    expect(
      importSummary(
        result({
          skipped: [
            { file: "AGENTS.md", title: "A", reason: "sudah-ada" },
            { file: "AGENTS.md", title: "B", reason: "sudah-ada" },
          ],
        }),
      ),
    ).toBe("Tidak ada usulan baru (2 sudah ada).");
  });

  test("hanya skipped karena alasan lain", () => {
    expect(
      importSummary(
        result({ skipped: [{ file: "AGENTS.md", title: "A", reason: "rahasia" }] }),
      ),
    ).toBe("Tidak ada usulan baru (1 dilewati).");
  });

  test("berkas tidak ditemukan", () => {
    expect(
      importSummary(
        result({
          files: [
            { file: "AGENTS.md", found: false },
            { file: "CLAUDE.md", found: false },
          ],
        }),
      ),
    ).toBe("AGENTS.md dan CLAUDE.md tidak ditemukan di folder ini.");
  });

  test("berkas ada tanpa bagian sama sekali", () => {
    expect(importSummary(result())).toBe("Tidak ada bagian baru di AGENTS.md.");
  });

  test("jumlah tidak diubah bentuknya (tanpa pluralisasi)", () => {
    const many = Array.from({ length: 4 }, () => created);
    expect(importSummary(result({ created: many }))).toBe(
      "4 usulan baru dari AGENTS.md.",
    );
  });
});
