import { describe, expect, test } from "bun:test";
import { fuzzyScore, filterCommands, buildCommands, type Command } from "../src/client/lib/commands";

describe("fuzzyScore", () => {
  test("awalan mendapat skor tertinggi", () => {
    expect(fuzzyScore("rapikan", "Rapikan dokumen")).toBeGreaterThan(1000);
    expect(fuzzyScore("fix", "Fix login issue")).toBeGreaterThan(1000);
  });

  test("awal kata mendapat skor menengah", () => {
    const score = fuzzyScore("login", "Perbaiki LOGIN");
    expect(score).toBeGreaterThanOrEqual(500);
    expect(score).toBeLessThan(1000);
  });

  test("subsequence mendapat skor lebih rendah tapi tetap positif", () => {
    const score = fuzzyScore("prbk", "Perbaiki login");
    expect(score).toBeDefined();
    expect(score!).toBeGreaterThan(100);
    expect(score!).toBeLessThan(500);
  });

  test("tidak cocok mengembalikan undefined", () => {
    expect(fuzzyScore("xyz", "abc def")).toBe(undefined);
    expect(fuzzyScore("aaa", "bbb")).toBe(undefined);
  });

  test("huruf besar kecil tidak berpengaruh", () => {
    expect(fuzzyScore("RAPIKAN", "Rapikan")).toEqual(fuzzyScore("rapikan", "Rapikan"));
  });

  test("diakritik diabaikan", () => {
    expect(fuzzyScore("kantor", "KANTOR")).toBeGreaterThan(100);
    expect(fuzzyScore("cafe", "Café")).toBeGreaterThan(100);
  });
});

describe("buildCommands", () => {
  function makeSession(overrides: Partial<{ id: string; title: string; cwd: string; status: string; archivedAt?: string }> = {}): any {
    return {
      id: "s1",
      title: "Test",
      cwd: "/tmp/test",
      status: "selesai",
      archivedAt: undefined,
      ...overrides,
    };
  }

  test("aksi muncul dulu tanpa sesi", () => {
    const cmds = buildCommands({ sessions: [], hasSession: false, panelOpen: false });
    const ids = cmds.map((c) => c.id);
    expect(ids[0]).toBe("new-session");
    expect(ids[1]).toBe("open-workspace");
    expect(ids[2]).toBe("open-mcp");
    expect(ids[cmds.length - 2]).toBe("focus-search");
    expect(ids[cmds.length - 1]).toBe("show-shortcuts");
  });

  test("perintah Buka Server MCP tersedia", () => {
    const cmds = buildCommands({ sessions: [], hasSession: false, panelOpen: false });
    const mcp = cmds.find((c) => c.id === "open-mcp");
    expect(mcp?.label).toBe("Buka Server MCP");
    expect(mcp?.run).toBe("open-mcp");
    expect(mcp?.group).toBe("aksi");
  });

  test("toggle-panel hanya bila ada sesi terbuka", () => {
    const withPanel = buildCommands({ sessions: [makeSession()], hasSession: true, panelOpen: true });
    expect(withPanel.some((c) => c.group === "aksi" && c.run === "toggle-panel")).toBe(true);

    const withoutSession = buildCommands({ sessions: [makeSession()], hasSession: false, panelOpen: false });
    expect(withoutSession.some((c) => c.group === "aksi" && c.run === "toggle-panel")).toBe(false);
  });

  test("perintah Buka panel Git hanya bila ada sesi terbuka", () => {
    const withSession = buildCommands({ sessions: [makeSession()], hasSession: true, panelOpen: false });
    const git = withSession.find((c) => c.id === "open-git");
    expect(git?.label).toBe("Buka panel Git");
    expect(git?.run).toBe("open-git");
    expect(git?.group).toBe("aksi");
    expect(git?.hint).toBeUndefined();

    const withoutSession = buildCommands({ sessions: [], hasSession: false, panelOpen: false });
    expect(withoutSession.some((c) => c.id === "open-git")).toBe(false);
  });

  test("sesi terarsip tidak ikut termasuk", () => {
    const active = makeSession({ id: "a", title: "Aktif" });
    const arch = makeSession({ id: "b", title: "Arsip", archivedAt: "2026-01-01T00:00:00.000Z" });
    const cmds = buildCommands({ sessions: [active, arch], hasSession: true, panelOpen: false });
    const labels = cmds.filter((c) => c.group === "sesi").map((c) => c.label);
    expect(labels).not.toContain("Arsip");
    expect(labels).toContain("Aktif");
  });

  test("hanya 50 sesi terakhir ditampilkan", () => {
    const sessions = Array.from({ length: 100 }, (_, i) => makeSession({ id: `s${i}`, title: `Sesi ${i}` }));
    const cmds = buildCommands({ sessions, hasSession: true, panelOpen: false });
    const count = cmds.filter((c) => c.group === "sesi").length;
    expect(count).toBe(50);
  });
});

describe("filterCommands", () => {
  function cmd(id: string, label: string, run: any, group: "aksi" | "sesi" = "aksi"): Command {
    return { id, label, group, run };
  }

  test("query kosong kembali urutan asli (dengan limit)", () => {
    const base = [cmd("1", "A", "1"), cmd("2", "B", "2")];
    expect(filterCommands(base, "", 2)).toHaveLength(2);
    expect(filterCommands(base, "", 1)).toHaveLength(1);
  });

  test("skor awalan > awal kata > subsequence dalam hasil tersortir", () => {
    const cmds: Command[] = [
      cmd("1", "Selesaikan isi", "1"),
      cmd("2", "Buka sesi", "2"),
      cmd("3", "Sesi baru", "3"),
    ];
    // "Sesi baru" diawali "sesi", "Buka sesi" cocok di awal kata, "Selesaikan isi" hanya subsequence.
    expect(fuzzyScore("sesi", "Sesi baru")).toBeGreaterThan(fuzzyScore("sesi", "Buka sesi")!);
    expect(fuzzyScore("sesi", "Buka sesi")).toBeGreaterThan(fuzzyScore("sesi", "Selesaikan isi")!);

    const filtered = filterCommands(cmds, "sesi");
    const labels = filtered.map((c) => c.label);
    expect(labels[0]).toBe("Sesi baru");
    expect(labels[labels.length - 1]).toBe("Selesaikan isi");
  });

  test("folder sesi ikut dicocokkan", () => {
    const commands: Command[] = [
      { id: "session-a", label: "Sesi biasa", group: "sesi", run: { session: "a" }, folder: "/kerja/kantor" },
    ];
    const filtered = filterCommands(commands, "kantor");
    expect(filtered.map((c) => c.id)).toEqual(["session-a"]);
  });

  test("query tidak cocok menghasilkan array kosong", () => {
    const cmds: Command[] = [cmd("1", "Alpha", "1"), cmd("2", "Beta", "2")];
    expect(filterCommands(cmds, "zzz")).toHaveLength(0);
  });
});
