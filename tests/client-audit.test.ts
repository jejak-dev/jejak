import { describe, expect, test } from "bun:test";
import type { AuditEntryItem } from "../src/client/lib/api";
import {
  AUDIT_KIND_LABELS,
  auditQueryFor,
  formatAuditTime,
  kindLabel,
  kindTone,
  mergeEntries,
  metaLine,
  sessionLabel,
  summaryLine,
} from "../src/client/lib/audit";

function entry(id: number, overrides: Partial<AuditEntryItem> = {}): AuditEntryItem {
  return {
    id,
    ts: "2026-11-09T07:00:00.000Z",
    sessionId: null,
    kind: "tool",
    summary: `aksi ${id}`,
    meta: {},
    ...overrides,
  };
}

describe("label dan nada jenis", () => {
  test("tiga belas jenis punya label Bahasa Indonesia", () => {
    expect(Object.keys(AUDIT_KIND_LABELS)).toHaveLength(13);
    expect(kindLabel("sesi-mulai")).toBe("Sesi mulai");
    expect(kindLabel("sesi-berhenti")).toBe("Sesi berhenti");
    expect(kindLabel("tool")).toBe("Tool");
    expect(kindLabel("izin")).toBe("Izin");
    expect(kindLabel("berkas")).toBe("Berkas");
    expect(kindLabel("git")).toBe("Git");
    expect(kindLabel("rahasia-disamarkan")).toBe("Rahasia disamarkan");
    expect(kindLabel("rahasia-diblokir")).toBe("Rahasia diblokir");
    expect(kindLabel("mcp")).toBe("MCP");
    expect(kindLabel("pengaturan")).toBe("Pengaturan");
    expect(kindLabel("anggaran")).toBe("Anggaran");
    expect(kindLabel("provider")).toBe("Provider");
    expect(kindLabel("sandbox")).toBe("Sandbox");
  });

  test("jenis tak dikenal dikembalikan mentah", () => {
    expect(kindLabel("lain")).toBe("lain");
  });

  test("nada hanya beda untuk jenis rahasia, anggaran, dan sandbox", () => {
    expect(kindTone("rahasia-diblokir")).toBe("bad");
    expect(kindTone("rahasia-disamarkan")).toBe("warn");
    expect(kindTone("anggaran")).toBe("warn");
    expect(kindTone("sandbox")).toBe("warn");
    expect(kindTone("provider")).toBe("");
    expect(kindTone("izin")).toBe("");
    expect(kindTone("tool")).toBe("");
  });
});

describe("metaLine", () => {
  test("kunci: nilai dipisah titik tengah", () => {
    expect(metaLine({ tool: "Read", path: "src/a.ts" })).toBe("tool: Read · path: src/a.ts");
  });

  test("boolean menjadi ya/tidak dan null dilewati", () => {
    expect(metaLine({ ok: true, batal: false, kosong: null })).toBe("ok: ya · batal: tidak");
  });

  test("nilai angka diteruskan", () => {
    expect(metaLine({ jumlah: 3 })).toBe("jumlah: 3");
  });

  test("maks enam pasangan", () => {
    const meta = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };
    expect(metaLine(meta)).toBe("a: 1 · b: 2 · c: 3 · d: 4 · e: 5 · f: 6");
  });

  test("nilai dipotong 40 karakter dengan elipsis", () => {
    const value = "x".repeat(45);
    const line = metaLine({ panjang: value });
    expect(line).toBe(`panjang: ${"x".repeat(40)}…`);
  });

  test("meta kosong atau tidak ada menghasilkan string kosong", () => {
    expect(metaLine({})).toBe("");
    expect(metaLine(undefined)).toBe("");
  });

  test("tag HTML tidak diinterpretasi, hanya teks", () => {
    const line = metaLine({ path: "<b>x</b>" });
    expect(line).toBe("path: <b>x</b>");
  });
});

describe("formatAuditTime", () => {
  const now = new Date(2026, 10, 9, 15, 0);
  const localIso = (y: number, m: number, d: number, h: number, min: number): string =>
    new Date(y, m, d, h, min).toISOString();

  test("hari ini hanya jam", () => {
    expect(formatAuditTime(localIso(2026, 10, 9, 14, 3), now)).toBe("14:03");
  });

  test("kemarin diberi awalan", () => {
    expect(formatAuditTime(localIso(2026, 10, 8, 9, 5), now)).toBe("kemarin 09:05");
  });

  test("lebih lama memakai tanggal dan bulan pendek", () => {
    expect(formatAuditTime(localIso(2026, 10, 1, 8, 30), now)).toBe("1 Nov 08:30");
  });

  test("ISO tak valid dikembalikan mentah", () => {
    expect(formatAuditTime("bukan tanggal", now)).toBe("bukan tanggal");
  });
});

describe("sessionLabel", () => {
  const sessions = [
    { id: "s1", title: "Perbaiki login" },
    { id: "s2", title: "Judul yang sangat panjang sekali melebihi batas" },
  ];

  test("judul sesi yang ada dipakai", () => {
    expect(sessionLabel("s1", sessions)).toBe("Perbaiki login");
  });

  test("judul dipotong 32 karakter", () => {
    expect(sessionLabel("s2", sessions)).toBe("Judul yang sangat panjang sekali…");
  });

  test("sesi tak dikenal memakai id", () => {
    expect(sessionLabel("s9", sessions)).toBe("sesi s9");
  });

  test("tanpa sesi mengembalikan undefined", () => {
    expect(sessionLabel(null, sessions)).toBeUndefined();
    expect(sessionLabel(undefined, sessions)).toBeUndefined();
    expect(sessionLabel("", sessions)).toBeUndefined();
  });
});

describe("auditQueryFor", () => {
  test("filter kosong hanya menyertakan limit", () => {
    expect(auditQueryFor({ kind: "", session: "" })).toEqual({ limit: 50 });
  });

  test("filter terisi dan kursor disertakan", () => {
    expect(auditQueryFor({ kind: "tool", session: "s1" }, 42)).toEqual({
      limit: 50,
      kind: "tool",
      session: "s1",
      before: 42,
    });
  });
});

describe("mergeEntries", () => {
  test("menggabung tanpa duplikat dan urut id menurun", () => {
    const merged = mergeEntries([entry(3), entry(1)], [entry(2), entry(3, { summary: "baru" })]);
    expect(merged.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(merged[0]?.summary).toBe("baru");
  });

  test("daftar kosong tetap kosong", () => {
    expect(mergeEntries([], [])).toEqual([]);
  });
});

describe("summaryLine", () => {
  const base = {
    days: 7,
    since: "2026-11-02T00:00:00.000Z",
    total: 12,
    byKind: {},
    redactedSessions: 0,
  };

  test("tanpa sesi tersamarkan", () => {
    expect(summaryLine(base)).toBe("12 aksi dalam 7 hari");
  });

  test("dengan sesi tersamarkan", () => {
    expect(summaryLine({ ...base, redactedSessions: 2 })).toBe(
      "12 aksi dalam 7 hari · 2 sesi dengan rahasia disamarkan",
    );
  });
});
