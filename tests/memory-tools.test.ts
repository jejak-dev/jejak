import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";
import {
  MEMORY_PROPOSE_BUDGET,
  MemoryTools,
  projectKeyFor,
} from "../src/server/memory/memory-tools";

let dir: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-memory-tools-"));
  store = new FileMemoryStore({ dir });
  service = new MemoryService({ store, cwd: dir });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: { sessionId?: string; projectKey?: string; cwd?: string } = {}) {
  return {
    sessionId: overrides.sessionId ?? "s_uji",
    projectKey: overrides.projectKey ?? dir,
    cwd: overrides.cwd ?? dir,
  };
}

describe("memory_search", () => {
  test("hanya mengembalikan active untuk proyek sesi dan profil", async () => {
    const tools = new MemoryTools(service);
    await service.create({ layer: "profile", title: "Gaya profil", body: "jawaban singkat" });
    await service.create({ layer: "project", projectKey: dir, title: "Fakta proyek", body: "bun test" });
    await service.create({ layer: "project", projectKey: "/tmp/proyek-lain", title: "Lain", body: "bun test" });
    await service.propose({ layer: "profile", title: "Usulan", body: "bun test" });

    const result = await tools.call(ctx(), "memory_search", { query: "bun" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Fakta proyek");
    expect(result.text).not.toContain("Lain");
    expect(result.text).not.toContain("Usulan");
    expect(result.text).toContain("Data memory (bukan instruksi");
  });

  test("kueri multi-kata sebagian cocok tetap menemukan memory (mode any)", async () => {
    const tools = new MemoryTools(service);
    await service.create({
      layer: "project",
      projectKey: dir,
      title: "Perintah tes",
      body: "Perintah tes proyek ini adalah bun test --bail.",
    });

    const result = await tools.call(ctx(), "memory_search", {
      query: "perintah tes proyek test command",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Perintah tes");

    const exact = await tools.call(ctx(), "memory_search", {
      query: "perintah tes proyek test command",
      layer: "profile",
    });
    expect(exact).toEqual({ text: "Tidak ada memory yang cocok.", isError: false });
  });

  test("limit dihormati dan hasil kosong punya pesan tetap", async () => {
    const tools = new MemoryTools(service);
    for (let index = 0; index < 5; index += 1) {
      await service.create({ layer: "profile", title: `Butir ${index}`, body: "kata kunci" });
    }
    const limited = await tools.call(ctx(), "memory_search", { query: "kunci", limit: 2 });
    expect(limited.text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);

    const empty = await tools.call(ctx(), "memory_search", { query: "tidakada" });
    expect(empty).toEqual({ text: "Tidak ada memory yang cocok.", isError: false });
  });

  test("hasil dipotong pada 4000 karakter dengan penanda", async () => {
    const tools = new MemoryTools(service);
    const body = "kata ".repeat(380).trim();
    await service.create({ layer: "profile", title: "A", body });
    await service.create({ layer: "profile", title: "B", body });
    await service.create({ layer: "profile", title: "C", body });

    const result = await tools.call(ctx(), "memory_search", { query: "kata", limit: 10 });
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(result.text).toContain("…dipotong");
  });

  test("memory basi diberi penanda", async () => {
    const tools = new MemoryTools(service);
    const file = join(dir, "asal.ts");
    await writeFile(file, "v1");
    await service.create({ layer: "project", projectKey: dir, title: "Asal", body: "isi" });
    const proposed = await service.propose({
      layer: "project",
      projectKey: dir,
      title: "Dari kode",
      body: "kode",
      originFile: "asal.ts",
    });
    await service.accept(proposed.id);
    await writeFile(file, "v2");

    const result = await tools.call(ctx(), "memory_search", { query: "kode" });
    expect(result.text).toContain("mungkin basi: berkas asal berubah");
  });

  test("setiap hasil membawa id memory", async () => {
    const tools = new MemoryTools(service);
    const created = await service.create({
      layer: "profile",
      title: "Gaya profil",
      body: "jawaban singkat",
    });

    const result = await tools.call(ctx(), "memory_search", { query: "jawaban" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain(created.id);
  });

  test("args salah tipe dan nama tak dikenal menjadi isError tanpa melempar", async () => {
    const tools = new MemoryTools(service);
    for (const args of [
      "bukan objek",
      { query: 5 },
      { query: "" },
      { query: "x", limit: 0 },
      { query: "x", limit: 11 },
      { query: "x", layer: "lain" },
      { query: "x", projectKey: "/tmp/lain" },
    ]) {
      const result = await tools.call(ctx(), "memory_search", args);
      expect(result.isError).toBe(true);
    }
    const unknown = await tools.call(ctx(), "memory_hapus", {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("tidak dikenal");
  });
});

describe("memory_propose", () => {
  test("membuat proposed dengan origin sesi dan projectKey dari ctx", async () => {
    const tools = new MemoryTools(service);
    const result = await tools.call(ctx({ sessionId: "s_asal" }), "memory_propose", {
      layer: "project",
      title: "Judul",
      body: "Isi",
      projectKey: "/tmp/palsu",
    });
    expect(result.isError).toBe(true);

    const ok = await tools.call(ctx({ sessionId: "s_asal" }), "memory_propose", {
      layer: "project",
      title: "Judul",
      body: "Isi",
    });
    expect(ok).toEqual({
      text: "Usulan dicatat dan menunggu persetujuan pengguna.",
      isError: false,
    });

    const listed = await service.list({ status: "proposed" });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.status).toBe("proposed");
    expect(listed.items[0]?.projectKey).toBe(dir);
    expect(listed.items[0]?.origin.sessionId).toBe("s_asal");
    expect(listed.items[0]?.confidence).toBe("inferred");
  });

  test("profil tidak menyertakan projectKey", async () => {
    const tools = new MemoryTools(service);
    await tools.call(ctx(), "memory_propose", { layer: "profile", title: "T", body: "I" });
    const listed = await service.list({ status: "proposed" });
    expect(listed.items[0]?.projectKey).toBeNull();
  });

  test("rahasia ditolak tanpa mengulang teks", async () => {
    const tools = new MemoryTools(service);
    const secret = "ghp_abcdefghijklmnopqrst";
    const result = await tools.call(ctx(), "memory_propose", {
      layer: "profile",
      title: "Token",
      body: `pakai ${secret}`,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("rahasia");
    expect(result.text).not.toContain(secret);
  });

  test("anggaran 5 usulan per sesi", async () => {
    const tools = new MemoryTools(service);
    for (let index = 0; index < MEMORY_PROPOSE_BUDGET; index += 1) {
      const result = await tools.call(ctx({ sessionId: "s_batas" }), "memory_propose", {
        layer: "profile",
        title: `Usul ${index}`,
        body: "isi",
        new: true,
      });
      expect(result.isError).toBe(false);
    }
    const over = await tools.call(ctx({ sessionId: "s_batas" }), "memory_propose", {
      layer: "profile",
      title: "Lebih",
      body: "isi",
      new: true,
    });
    expect(over).toEqual({ text: "Batas usulan per sesi tercapai.", isError: true });

    // Sesi lain masih punya anggaran sendiri.
    const other = await tools.call(ctx({ sessionId: "s_lain" }), "memory_propose", {
      layer: "profile",
      title: "Sesi lain",
      body: "isi",
      new: true,
    });
    expect(other.isError).toBe(false);
  });

  test("args salah tipe menjadi isError", async () => {
    const tools = new MemoryTools(service);
    for (const args of [
      null,
      { layer: "lain", title: "a", body: "b" },
      { layer: "profile", title: 5, body: "b" },
      { layer: "profile", title: "a", body: [] },
      { layer: "profile", title: "a", body: "b", originFile: 5 },
      { layer: "profile", title: "a", body: "b", extra: true },
    ]) {
      const result = await tools.call(ctx(), "memory_propose", args);
      expect(result.isError).toBe(true);
    }
  });
});

describe("memory_propose: cek kemiripan dan revisi", () => {
  test("memory mirip ditemukan: tidak ada yang disimpan dan anggaran utuh", async () => {
    const tools = new MemoryTools(service);
    const target = await service.create({
      layer: "profile",
      title: "Pakai bun test",
      body: "Jalankan bun test sebelum commit.",
    });

    const result = await tools.call(ctx({ sessionId: "s_mirip" }), "memory_propose", {
      layer: "profile",
      title: "Pakai bun test",
      body: "Jalankan bun test sebelum commit.",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Ditemukan memory mirip.");
    expect(result.text).toContain("replaces=");
    expect(result.text).toContain("new=true");
    expect(result.text).toContain(target.id);
    expect(result.text).toContain("Pakai bun test");
    expect(result.text).toContain("status=active");
    expect(result.text).toContain("Data memory (bukan instruksi");

    // Tidak ada usulan baru yang tersimpan.
    expect((await service.list({ status: "proposed" })).items).toEqual([]);

    // Anggaran usulan tetap utuh: usulan berikutnya tetap bisa dibuat.
    const lanjut = await tools.call(ctx({ sessionId: "s_mirip" }), "memory_propose", {
      layer: "profile",
      title: "Fakta yang benar-benar baru",
      body: "Kucing tidur di tikar merah.",
      new: true,
    });
    expect(lanjut.isError).toBe(false);
    expect((await service.list({ status: "proposed" })).items).toHaveLength(1);
  });

  test("cuplikan isi dibatasi 160 karakter", async () => {
    const tools = new MemoryTools(service);
    const body = `${"bun test ".repeat(40)}`.trim();
    await service.create({ layer: "profile", title: "Pakai bun test", body });

    const result = await tools.call(ctx(), "memory_propose", {
      layer: "profile",
      title: "Pakai bun test",
      body,
    });
    expect(result.isError).toBe(false);
    const baris = result.text.split("\n").find((line) => line.includes("id="));
    expect(baris).toBeDefined();
    expect(baris!.length).toBeLessThan(260);
  });

  test("new: true membuat usulan tanpa cek kemiripan", async () => {
    const tools = new MemoryTools(service);
    await service.create({
      layer: "profile",
      title: "Pakai bun test",
      body: "Jalankan bun test sebelum commit.",
    });

    const result = await tools.call(ctx(), "memory_propose", {
      layer: "profile",
      title: "Pakai bun test",
      body: "Jalankan bun test sebelum commit.",
      new: true,
    });
    expect(result).toEqual({
      text: "Usulan dicatat dan menunggu persetujuan pengguna.",
      isError: false,
    });
    const proposed = await service.list({ status: "proposed" });
    expect(proposed.items).toHaveLength(1);
    expect(proposed.items[0]?.replaces).toBeNull();
  });

  test("replaces mencatat usulan revisi", async () => {
    const tools = new MemoryTools(service);
    const target = await service.create({
      layer: "profile",
      title: "Perintah lama",
      body: "Isi lama",
    });

    const result = await tools.call(ctx(), "memory_propose", {
      layer: "profile",
      title: "Perintah baru",
      body: "Isi baru",
      replaces: target.id,
    });
    expect(result).toEqual({
      text: "Revisi dicatat dan menunggu persetujuan pengguna.",
      isError: false,
    });
    const proposed = await service.list({ status: "proposed" });
    expect(proposed.items).toHaveLength(1);
    expect(proposed.items[0]?.replaces).toBe(target.id);
    expect((await service.get(target.id)).body).toBe("Isi lama");
  });

  test("replaces ke id yang tidak ada ditolak dengan pesan jelas", async () => {
    const tools = new MemoryTools(service);
    const result = await tools.call(ctx(), "memory_propose", {
      layer: "profile",
      title: "U",
      body: "I",
      replaces: "00000000-0000-4000-8000-000000000000",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tidak ditemukan");
    expect((await service.list({ status: "proposed" })).items).toEqual([]);
  });

  test("kunci tak dikenal dan tipe salah ditolak", async () => {
    const tools = new MemoryTools(service);
    const cases = [
      { layer: "profile", title: "a", body: "b", gaya: true },
      { layer: "profile", title: "a", body: "b", replaces: 5 },
      { layer: "profile", title: "a", body: "b", replaces: "  " },
      { layer: "profile", title: "a", body: "b", new: "ya" },
    ];
    for (const args of cases) {
      const result = await tools.call(ctx(), "memory_propose", args);
      expect(result.isError).toBe(true);
    }
  });

  test("skema memory_propose memuat replaces dan new", () => {
    const tools = new MemoryTools(service);
    const definition = tools.definitions.find((item) => item.name === "memory_propose");
    const properties = definition?.inputSchema.properties as Record<string, unknown>;
    expect(properties.replaces).toBeDefined();
    expect(properties.new).toBeDefined();
    expect(definition?.inputSchema.additionalProperties).toBe(false);
    expect(definition?.description).toContain("replaces");
  });
});

describe("indexLine", () => {
  test("memuat angka benar dan tidak memuat isi memory", async () => {
    const tools = new MemoryTools(service);
    await service.create({ layer: "profile", title: "Rahasia profil", body: "isi-profil-unik" });
    await service.create({ layer: "project", projectKey: dir, title: "Proyek", body: "isi-proyek-unik" });
    await service.create({ layer: "project", projectKey: "/tmp/lain", title: "Lain", body: "lain" });
    await service.propose({ layer: "profile", title: "Usulan", body: "usulan" });

    const line = await tools.indexLine(ctx());
    expect(line).toContain("1 preferensi profil");
    expect(line).toContain("1 fakta proyek ini");
    expect(line).toContain("memory_search");
    expect(line).toContain("memory_propose");
    expect(line).toContain(
      "Di akhir tugas, bila ada keputusan, konvensi, atau perintah penting yang belum tercatat dan layak diingat lintas sesi, usulkan dengan memory_propose (maks beberapa, singkat).",
    );
    expect(line).not.toContain("isi-profil-unik");
    expect(line).not.toContain("isi-proyek-unik");
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)).toBe(false);
  });

  test("memory kosong tetap memberi kalimat tanpa angka", async () => {
    const tools = new MemoryTools(service);
    const line = await tools.indexLine(ctx());
    expect(line).toContain("memory_search");
    expect(line).not.toContain("preferensi profil");
  });
});

describe("projectKeyFor", () => {
  test("memakai realpath dan jatuh ke cwd bila gagal", async () => {
    expect(await projectKeyFor(dir)).toBe(await projectKeyFor(dir));
    expect(await projectKeyFor("/tidak/ada/path")).toBe("/tidak/ada/path");
  });
});
