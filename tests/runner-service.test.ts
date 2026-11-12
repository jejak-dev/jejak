import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditStore } from "../src/server/audit/audit-store";
import {
  RunnerError,
  RunnerService,
  type RunnerTerminal,
} from "../src/server/runner/runner-service";
import { FileRunnerStore } from "../src/server/runner/runner-store";
import { TerminalError } from "../src/server/terminal/terminal-manager";

const BARIS_BARU = String.fromCharCode(10);
const KEMBALIAN = String.fromCharCode(13);

/** Terminal palsu: mencatat create dan write tanpa menjalankan shell. */
class TerminalPalsu implements RunnerTerminal {
  readonly dibuat: Array<{ cwd: unknown }> = [];
  readonly ditulis: Array<{ id: string; data: unknown }> = [];
  galat: Error | undefined;

  create(input: { cwd: unknown; cols?: unknown; rows?: unknown }): { id: string; cwd: string } {
    this.dibuat.push({ cwd: input.cwd });
    if (this.galat !== undefined) throw this.galat;
    return { id: `t${this.dibuat.length}`, cwd: String(input.cwd) };
  }

  write(id: string, data: unknown): void {
    this.ditulis.push({ id, data });
  }
}

let dir: string;
let terminal: TerminalPalsu;
let audit: SqliteAuditStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-runner-service-"));
  terminal = new TerminalPalsu();
  audit = new SqliteAuditStore(":memory:");
});

afterEach(async () => {
  audit.close();
  await rm(dir, { recursive: true, force: true });
});

function buatLayanan(options: { terminal?: RunnerTerminal; cwd?: string } = {}): RunnerService {
  const terminalOpsi = "terminal" in options ? options.terminal : terminal;
  return new RunnerService({
    store: new FileRunnerStore(":memory:"),
    terminal: terminalOpsi,
    allowedCwds: () => [options.cwd ?? dir],
    audit,
  });
}

async function tulisPackage(scripts: Record<string, string>): Promise<void> {
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts }), "utf8");
}

describe("layanan runner", () => {
  test("daftar menggabungkan script package lebih dulu lalu perintah kustom", async () => {
    await tulisPackage({ test: "bun test" });
    const layanan = buatLayanan();
    const custom = layanan.addCustom({
      cwd: dir,
      label: "PerBuild",
      command: "bun run build",
      group: "Build",
    });

    const daftar = layanan.list(dir);
    expect(daftar.map((item) => item.source)).toEqual(["package", "custom"]);
    expect(daftar[0]?.label).toBe("test");
    expect(daftar[0]?.command).toBe("bun run test");
    expect(daftar[0]?.confirmed).toBe(false);
    // Isi script ikut dikirim agar konfirmasi menampilkan yang benar-benar berjalan.
    expect(daftar[0]?.detail).toBe("bun test");
    expect(daftar[1]?.detail).toBeUndefined();
    expect(daftar[1]?.id).toBe(custom.id);
    expect(daftar[1]?.group).toBe("Build");
    expect(daftar[1]?.source).toBe("custom");
  });

  test("folder tak dikenal ditolak", () => {
    const layanan = buatLayanan();
    expect(() => layanan.list(join(dir, "lain"))).toThrow(RunnerError);
    try {
      layanan.list(join(dir, "lain"));
    } catch (error) {
      expect((error as RunnerError).code).toBe("tidak-ditemukan");
    }
    expect(() => layanan.run({ cwd: join(dir, "lain"), id: "c_12345678" })).toThrow(
      /Folder tidak dikenal/,
    );
  });

  test("perintah belum dikonfirmasi ditolak dan tidak menyentuh terminal", async () => {
    await tulisPackage({ test: "bun test" });
    const layanan = buatLayanan();
    const id = layanan.list(dir)[0]!.id;

    try {
      layanan.run({ cwd: dir, id });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("konflik");
      expect((error as RunnerError).message).toBe("Perintah belum dikonfirmasi.");
    }
    expect(terminal.dibuat).toHaveLength(0);
    expect(terminal.ditulis).toHaveLength(0);
  });

  test("confirm=true menjalankan perintah dan menyimpan hash", async () => {
    await tulisPackage({ test: "bun test" });
    const layanan = buatLayanan();
    const id = layanan.list(dir)[0]!.id;

    const hasil = layanan.run({ cwd: dir, id, confirm: true });
    expect(hasil.terminalId).toBe("t1");
    expect(terminal.dibuat).toEqual([{ cwd: dir }]);
    // Teks yang ditulis hanya perintah dari daftar server.
    expect(terminal.ditulis).toEqual([{ id: "t1", data: "bun run test" + BARIS_BARU }]);
    expect(layanan.list(dir)[0]?.confirmed).toBe(true);

    // Jalankan lagi tanpa confirm: langsung jalan.
    const kedua = layanan.run({ cwd: dir, id });
    expect(kedua.terminalId).toBe("t2");
    expect(terminal.ditulis).toHaveLength(2);
  });

  test("perintah kustom yang diubah membatalkan konfirmasi", () => {
    const layanan = buatLayanan();
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    layanan.run({ cwd: dir, id: custom.id, confirm: true });
    expect(layanan.list(dir)[0]?.confirmed).toBe(true);

    layanan.updateCustom({ cwd: dir, id: custom.id, command: "bun test --watch" });
    expect(layanan.list(dir)[0]?.confirmed).toBe(false);
    try {
      layanan.run({ cwd: dir, id: custom.id });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("konflik");
    }
  });

  test("ubah label saja tidak membatalkan konfirmasi", () => {
    const layanan = buatLayanan();
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    layanan.run({ cwd: dir, id: custom.id, confirm: true });
    layanan.updateCustom({ cwd: dir, id: custom.id, label: "Uji Baru" });
    expect(layanan.list(dir)[0]?.confirmed).toBe(true);
  });

  test("isi script package yang berubah membatalkan konfirmasi", async () => {
    await tulisPackage({ test: "bun test" });
    const layanan = buatLayanan();
    const id = layanan.list(dir)[0]!.id;
    layanan.run({ cwd: dir, id, confirm: true });
    expect(layanan.list(dir)[0]?.confirmed).toBe(true);

    await tulisPackage({ test: "bun test --watch" });
    expect(layanan.list(dir)[0]?.confirmed).toBe(false);
    try {
      layanan.run({ cwd: dir, id });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("konflik");
    }
  });

  test("hapus perintah kustom menghapus konfirmasi", () => {
    const layanan = buatLayanan();
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    layanan.run({ cwd: dir, id: custom.id, confirm: true });
    layanan.deleteCustom({ cwd: dir, id: custom.id });
    expect(layanan.list(dir)).toEqual([]);
    try {
      layanan.run({ cwd: dir, id: custom.id });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("tidak-ditemukan");
    }
  });

  test("terminal dimatikan menjawab nonaktif", () => {
    const layanan = buatLayanan({ terminal: undefined });
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    try {
      layanan.run({ cwd: dir, id: custom.id, confirm: true });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("nonaktif");
      expect((error as RunnerError).message).toContain("JEJAK_TERMINAL=1");
    }
  });

  test("batas terminal menjadi galat batas", () => {
    terminal.galat = new TerminalError("Batas 4 terminal aktif tercapai.", "batas");
    const layanan = buatLayanan();
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    try {
      layanan.run({ cwd: dir, id: custom.id, confirm: true });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("batas");
    }
  });

  test("batas 40 perintah kustom per folder", () => {
    const layanan = buatLayanan();
    for (let index = 0; index < 40; index += 1) {
      layanan.addCustom({ cwd: dir, label: `P${index}`, command: `echo ${index}` });
    }
    expect(layanan.list(dir)).toHaveLength(40);
    try {
      layanan.addCustom({ cwd: dir, label: "Melebihi", command: "echo lebih" });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("batas");
    }
  });

  test("validasi perintah kustom", () => {
    const layanan = buatLayanan();
    const salah: Array<{ label: unknown; command: unknown; group?: unknown }> = [
      { label: "", command: "bun test" },
      { label: "x".repeat(61), command: "bun test" },
      { label: "Uji", command: "" },
      { label: "Uji", command: "x".repeat(501) },
      { label: "Uji", command: `bun test${BARIS_BARU}bun build` },
      { label: "Uji", command: `bun test${KEMBALIAN}` },
      { label: "Uji", command: "bun test", group: "y".repeat(41) },
    ];
    for (const input of salah) {
      try {
        layanan.addCustom({ cwd: dir, ...input });
        throw new Error(`harusnya ditolak: ${JSON.stringify(input)}`);
      } catch (error) {
        expect((error as RunnerError).code).toBe("tidak-valid");
      }
    }
    expect(layanan.list(dir)).toEqual([]);
  });

  test("id perintah tak dikenal menjawab tidak-ditemukan", () => {
    const layanan = buatLayanan();
    try {
      layanan.run({ cwd: dir, id: "c_00000000", confirm: true });
      throw new Error("harusnya ditolak");
    } catch (error) {
      expect((error as RunnerError).code).toBe("tidak-ditemukan");
    }
    expect(terminal.dibuat).toHaveLength(0);
  });

  test("audit mencatat aksi runner tanpa teks panjang", () => {
    const layanan = buatLayanan();
    const panjang = `echo ${"x".repeat(400)}`;
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: panjang });
    layanan.run({ cwd: dir, id: custom.id, confirm: true });
    layanan.updateCustom({ cwd: dir, id: custom.id, label: "Uji Baru" });
    layanan.deleteCustom({ cwd: dir, id: custom.id });

    const entri = audit.list({ kind: "pengaturan", limit: 20 });
    const aksi = entri.map((item) => meta(item)["aksi"]);
    expect(aksi).toContain("runner-tambah");
    expect(aksi).toContain("runner-ubah");
    expect(aksi).toContain("runner-hapus");
    expect(aksi).toContain("runner-jalankan");
    const jalankan = entri.find((item) => meta(item)["aksi"] === "runner-jalankan");
    const isi = meta(jalankan);
    expect(String(isi["perintah"] ?? "").length).toBeLessThanOrEqual(200);
    expect(String(isi["hash"] ?? "")).toMatch(/^[0-9a-f]{64}$/);
    expect(isi["cwd"]).toBe(dir);
  });

  test("konfirmasi gagal tidak dicatat di audit", () => {
    const layanan = buatLayanan();
    const custom = layanan.addCustom({ cwd: dir, label: "Uji", command: "bun test" });
    try {
      layanan.run({ cwd: dir, id: custom.id });
    } catch {
      // Gagal konfirmasi memang diharapkan.
    }
    const aksi = audit.list({ kind: "pengaturan", limit: 20 }).map((item) => meta(item)["aksi"]);
    expect(aksi).not.toContain("runner-jalankan");
  });
});

/** Meta audit dibaca sebagai catatan sederhana. */
function meta(entry: unknown): Record<string, unknown> {
  const record = entry as { meta?: Record<string, unknown> };
  return record.meta ?? {};
}
