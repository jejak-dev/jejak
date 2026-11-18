import { describe, expect, test } from "bun:test";
import {
  describeToolCalling,
  folderName,
  formatAgo,
  formatCost,
  formatCount,
  formatRelative,
  groupSessions,
  memoryHash,
  parseHashRoute,
  providersHash,
  sessionHash,
  shortPath,
  statusTone,
} from "../src/client/lib/format";

describe("formatCost", () => {
  test("undefined menjadi tanda pisah", () => {
    expect(formatCost()).toBe("–");
  });

  test("nol dan nilai sangat kecil", () => {
    expect(formatCost(0)).toBe("$0,00");
    expect(formatCost(0.004)).toBe("$0,004");
    expect(formatCost(0.0021)).toBe("$0,0021");
    expect(formatCost(0.00001)).toBe("<$0,0001");
  });

  test("dua desimal dengan koma", () => {
    expect(formatCost(1.25)).toBe("$1,25");
    expect(formatCost(12)).toBe("$12,00");
  });
});

describe("formatCount", () => {
  test("undefined menjadi tanda pisah", () => {
    expect(formatCount()).toBe("–");
  });

  test("pemisah ribuan id-ID", () => {
    expect(formatCount(1234567)).toBe("1.234.567");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-07T12:00:00.000Z");

  test("baru saja di bawah 45 detik", () => {
    expect(formatRelative("2026-11-07T11:59:30.000Z", now)).toBe("baru saja");
    expect(formatRelative("2026-11-07T11:59:20.000Z", now)).toBe("baru saja");
  });

  test("menit dan jam", () => {
    expect(formatRelative("2026-11-07T11:55:00.000Z", now)).toBe("5 mnt lalu");
    expect(formatRelative("2026-11-07T09:00:00.000Z", now)).toBe("3 jam lalu");
  });

  test("kemarin lalu tanggal pendek", () => {
    expect(formatRelative("2026-11-06T11:00:00.000Z", now)).toBe("kemarin");
    expect(formatRelative("2026-11-01T12:00:00.000Z", now)).toBe("1 Nov");
  });

  test("ISO tidak valid menjadi string kosong", () => {
    expect(formatRelative("bukan tanggal", now)).toBe("");
  });
});

describe("statusTone", () => {
  test("memetakan status ke nada", () => {
    expect(statusTone("berjalan")).toBe("accent");
    expect(statusTone("selesai")).toBe("success");
    expect(statusTone("gagal")).toBe("danger");
    expect(statusTone("dibatalkan")).toBe("muted");
  });
});

describe("shortPath", () => {
  test("path pendek dikembalikan apa adanya", () => {
    expect(shortPath("/tmp")).toBe("/tmp");
  });

  test("memotong dari depan dan menyisakan segmen terakhir", () => {
    const path = "/Users/budi/Developer/proyek-yang-cukup-panjang/src";
    const result = shortPath(path, 20);
    expect(result.startsWith("…/")).toBe(true);
    expect(result.endsWith("/src")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test("segmen terakhir yang terlalu panjang tetap utuh", () => {
    const path = `/a/${"x".repeat(40)}`;
    expect(shortPath(path, 10)).toBe(`…/${"x".repeat(40)}`);
  });
});

describe("hash route", () => {
  test("membaca id sesi", () => {
    expect(parseHashRoute("#/s/s_abcdef12")).toEqual({ sessionId: "s_abcdef12" });
  });

  test("decode id", () => {
    expect(parseHashRoute("#/s/s_ab%2Dcd")).toEqual({ sessionId: "s_ab-cd" });
  });

  test("rute lain dan id tidak valid menjadi objek kosong", () => {
    expect(parseHashRoute("#/")).toEqual({});
    expect(parseHashRoute("#/s/")).toEqual({});
    expect(parseHashRoute("#/s/a b")).toEqual({});
    expect(parseHashRoute("#/s/a".padEnd(80, "b"))).toEqual({});
    expect(parseHashRoute("")).toEqual({});
  });

  test("sessionHash", () => {
    expect(sessionHash("s1")).toBe("#/s/s1");
    expect(sessionHash()).toBe("#/");
  });

  test("rute providers", () => {
    expect(parseHashRoute(providersHash())).toEqual({ view: "providers" });
    expect(providersHash()).toBe("#/providers");
    expect(parseHashRoute("#/providers/")).toEqual({});
    expect(parseHashRoute("#/provider")).toEqual({});
  });

  test("rute memory", () => {
    expect(parseHashRoute(memoryHash())).toEqual({ view: "memory" });
    expect(memoryHash()).toBe("#/memory");
    expect(parseHashRoute("#/memory/")).toEqual({});
    expect(parseHashRoute("#/memori")).toEqual({});
  });
});

describe("describeToolCalling", () => {
  test("memetakan status ke label dan nada", () => {
    expect(describeToolCalling("ok")).toEqual({
      label: "Tool calling berfungsi",
      tone: "success",
    });
    expect(describeToolCalling("tidak-dipanggil")).toEqual({
      label: "Model tidak memanggil tool; agen mungkin kurang andal",
      tone: "warning",
    });
    expect(describeToolCalling("tidak-diuji")).toEqual({
      label: "Tool calling tidak diuji",
      tone: "muted",
    });
  });
});

describe("folderName", () => {
  test("mengambil segmen terakhir path", () => {
    expect(folderName("/Users/boy/Developer/jejak")).toBe("jejak");
    expect(folderName("/Users/boy/Developer/jejak/")).toBe("jejak");
    expect(folderName("/")).toBe("/");
  });

  test("path Windows memakai backslash", () => {
    expect(folderName("C:\\Development\\pine-energy\\web-portal-be-transaction")).toBe(
      "web-portal-be-transaction",
    );
    expect(folderName("C:\\Development\\app\\")).toBe("app");
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString();

  test("satuan ringkas", () => {
    expect(formatAgo(ago(10_000), now)).toBe("baru");
    expect(formatAgo(ago(5 * 60_000), now)).toBe("5m");
    expect(formatAgo(ago(3 * 3_600_000), now)).toBe("3j");
    expect(formatAgo(ago(2 * 86_400_000), now)).toBe("2h");
  });

  test("tanggal tak valid menjadi kosong", () => {
    expect(formatAgo("bukan-tanggal", now)).toBe("");
  });
});

describe("groupSessions", () => {
  const make = (id: string, cwd: string, updatedAt: string) => ({ id, cwd, updatedAt });

  test("mengelompokkan per folder, terbaru di atas", () => {
    const groups = groupSessions([
      make("a", "/x/jejak", "2026-11-08T10:00:00.000Z"),
      make("b", "/x/alpha", "2026-11-08T12:00:00.000Z"),
      make("c", "/x/jejak", "2026-11-08T11:00:00.000Z"),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["alpha", "jejak"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["c", "a"]);
  });

  test("daftar kosong menghasilkan kelompok kosong", () => {
    expect(groupSessions([])).toEqual([]);
  });
});

describe("rute workspace", () => {
  test("hash dan parsing", async () => {
    const { workspacesHash } = await import("../src/client/lib/format");
    expect(workspacesHash()).toBe("#/workspaces");
    expect(parseHashRoute(workspacesHash())).toEqual({ view: "workspaces" });
    expect(parseHashRoute("#/workspaces/")).toEqual({});
    expect(parseHashRoute("#/workspace")).toEqual({});
  });
});

describe("rute MCP", () => {
  test("hash dan parsing", async () => {
    const { mcpHash } = await import("../src/client/lib/format");
    expect(mcpHash()).toBe("#/mcp");
    expect(parseHashRoute(mcpHash())).toEqual({ view: "mcp" });
    expect(parseHashRoute("#/mcp/")).toEqual({});
    expect(parseHashRoute("#/mcp-servers")).toEqual({});
  });
});

describe("canonicalPath dan pengelompokan worktree", () => {
  test("/private/tmp disamakan dengan /tmp, jalur lain tetap", async () => {
    const { canonicalPath } = await import("../src/client/lib/format");
    expect(canonicalPath("/private/tmp/x/a.ts")).toBe("/tmp/x/a.ts");
    expect(canonicalPath("/private/var/folders/a")).toBe("/var/folders/a");
    expect(canonicalPath("/private/other")).toBe("/private/other");
    expect(canonicalPath("/Users/me/proj")).toBe("/Users/me/proj");
  });

  test("sesi worktree dikelompokkan di bawah repo asal", async () => {
    const { groupSessions } = await import("../src/client/lib/format");
    const groups = groupSessions([
      { cwd: "/tmp/repo", updatedAt: "2026-11-10T10:00:00Z" },
      {
        cwd: "/home/u/.jejak/worktrees/s_1",
        updatedAt: "2026-11-10T11:00:00Z",
        worktree: { repoRoot: "/private/tmp/repo" },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("repo");
    expect(groups[0]?.items).toHaveLength(2);
  });
});
