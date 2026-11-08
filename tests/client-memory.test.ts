import { describe, expect, test } from "bun:test";
import type { MemoryItem } from "../src/client/lib/api";
import {
  MEMORY_BODY_MAX,
  MEMORY_TITLE_MAX,
  canAccept,
  canArchive,
  canEdit,
  canReject,
  confidenceLabel,
  filterByLayer,
  layerLabel,
  memoryDateLabel,
  originLabel,
  projectLabel,
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
