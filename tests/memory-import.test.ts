import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/server/memory/memory-service";
import { FileMemoryStore } from "../src/server/memory/memory-store";

let root: string;
let project: string;
let store: FileMemoryStore;
let service: MemoryService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-memory-import-"));
  project = join(root, "proyek");
  await mkdir(project, { recursive: true });
  store = new FileMemoryStore({ dir: join(root, "memory") });
  service = new MemoryService({ store, cwd: project });
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const FENCE = "```";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("importProjectDocs", () => {
  test("memecah AGENTS.md dan CLAUDE.md per judul ##", async () => {
    const agents = [
      "# Panduan Proyek",
      "",
      "Teks pra-judul.",
      "",
      "## Perintah",
      "",
      "bun test",
      "",
      FENCE + "bash",
      "## bukan judul",
      FENCE,
      "",
      "### Sub",
      "",
      "detail sub",
      "",
      "## Konvensi",
      "",
      "gaya",
      "",
    ].join("\n");
    const claude = "## Catatan\n\nhal penting\n";
    await writeFile(join(project, "AGENTS.md"), agents);
    await writeFile(join(project, "CLAUDE.md"), claude);

    const result = await service.importProjectDocs(project);

    expect(result.created.map((item) => item.title)).toEqual([
      "Panduan Proyek",
      "Perintah",
      "Konvensi",
      "Catatan",
    ]);
    expect(result.files).toEqual([
      { file: "AGENTS.md", found: true },
      { file: "CLAUDE.md", found: true },
    ]);
    expect(result.skipped).toEqual([]);

    const pre = result.created[0]!;
    expect(pre.body).toContain("Teks pra-judul.");
    expect(pre.body).not.toContain("# Panduan Proyek");

    const perintah = result.created[1]!;
    expect(perintah.body).toContain("## bukan judul");
    expect(perintah.body).toContain("### Sub");
    expect(perintah.body).toContain("detail sub");

    for (const item of result.created) {
      expect(item.status).toBe("proposed");
      expect(item.layer).toBe("project");
      expect(item.projectKey).toBe(project);
      expect(item.confidence).toBe("from_code");
      expect(item.origin.kind).toBe("file");
      expect(item.origin.file).toBe(item.title === "Catatan" ? "CLAUDE.md" : "AGENTS.md");
      expect(item.origin.fileSha256).toBe(
        item.origin.file === "CLAUDE.md" ? sha256(claude) : sha256(agents),
      );
    }
  });

  test("melewati bagian kosong, terlalu panjang, dan rahasia tanpa membocorkan teks", async () => {
    const secret = "ghp_abcdefghijklmnopqrst";
    const body = [
      "## Kosong",
      "",
      "## Panjang",
      "",
      "kata ".repeat(401).trim(),
      "",
      "## Token",
      "",
      `pakai ${secret}`,
      "",
      "## Sah",
      "",
      "isi sah",
      "",
    ].join("\n");
    await writeFile(join(project, "AGENTS.md"), body);

    const result = await service.importProjectDocs(project);

    expect(result.created.map((item) => item.title)).toEqual(["Sah"]);
    const reasons = result.skipped.map((item) => `${item.title}:${item.reason}`);
    expect(reasons).toContain("Kosong:kosong");
    expect(reasons).toContain("Panjang:terlalu-panjang");
    expect(reasons).toContain("Token:rahasia");
    const serialized = JSON.stringify(result.skipped);
    expect(serialized).not.toContain(secret);
  });

  test("idempoten dan dedup lintas status serta proyek", async () => {
    await writeFile(join(project, "AGENTS.md"), "## Perintah\n\nbun test\n\n## Gaya\n\nsingkat\n");

    const first = await service.importProjectDocs(project);
    expect(first.created).toHaveLength(2);

    const second = await service.importProjectDocs(project);
    expect(second.created).toHaveLength(0);
    expect(second.skipped.every((item) => item.reason === "sudah-ada")).toBe(true);

    // Judul sama dengan huruf berbeda tidak dibuat lagi.
    await writeFile(join(project, "AGENTS.md"), "## perintah\n\nbun test\n\n## Gaya\n\nsingkat\n");
    const third = await service.importProjectDocs(project);
    expect(third.created).toHaveLength(0);

    // Judul yang pernah ditolak juga tidak dibuat lagi.
    await service.reject(first.created[0]!.id);
    const fourth = await service.importProjectDocs(project);
    expect(fourth.created).toHaveLength(0);

    // Proyek lain tidak terpengaruh.
    const other = join(root, "proyek-lain");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "AGENTS.md"), "## Perintah\n\nbun test\n");
    const otherService = new MemoryService({ store, cwd: other });
    const otherResult = await otherService.importProjectDocs(other);
    expect(otherResult.created).toHaveLength(1);
    expect(otherResult.created[0]!.projectKey).toBe(other);
  });

  test("berhenti sebagai 'batas' saat 200 usulan terbuka tercapai", async () => {
    const sections: string[] = [];
    for (let index = 0; index < 202; index += 1) {
      sections.push(`## Bagian ${index}`, "", `isi ${index}`, "");
    }
    await writeFile(join(project, "AGENTS.md"), sections.join("\n"));

    const result = await service.importProjectDocs(project);

    expect(result.created).toHaveLength(200);
    const batas = result.skipped.filter((item) => item.reason === "batas");
    expect(batas).toHaveLength(2);
    expect(result.created[0]!.status).toBe("proposed");
  }, 60_000);

  test("menolak projectKey relatif, NUL, dan yang tidak ada", async () => {
    for (const bad of ["relatif/x", `${project}\0x`, join(root, "tidak-ada")]) {
      await expect(service.importProjectDocs(bad)).rejects.toThrow(
        "Folder proyek tidak ditemukan.",
      );
    }
  });

  test("symlink keluar akar dianggap tidak ada", async () => {
    const outside = join(root, "luar.md");
    await writeFile(outside, "## Luar\n\nrahasia proyek lain\n");
    await symlink(outside, join(project, "AGENTS.md"));

    const result = await service.importProjectDocs(project);

    expect(result.created).toHaveLength(0);
    expect(result.files).toEqual([
      { file: "AGENTS.md", found: false },
      { file: "CLAUDE.md", found: false },
    ]);
  });

  test("berkas lebih dari 64 KiB dilewati seluruhnya", async () => {
    await writeFile(join(project, "AGENTS.md"), `## Besar\n\n${"kata ".repeat(14_000)}`);

    const result = await service.importProjectDocs(project);

    expect(result.created).toHaveLength(0);
    expect(result.files).toEqual([
      { file: "AGENTS.md", found: true },
      { file: "CLAUDE.md", found: false },
    ]);
    expect(result.skipped).toEqual([
      { file: "AGENTS.md", title: "AGENTS.md", reason: "terlalu-panjang" },
    ]);
  });

  test("direktori bernama AGENTS.md dianggap tidak ada", async () => {
    await mkdir(join(project, "AGENTS.md"));

    const result = await service.importProjectDocs(project);

    expect(result.created).toHaveLength(0);
    expect(result.files[0]).toEqual({ file: "AGENTS.md", found: false });
  });

  test("berkas asal berubah menandai basi setelah diterima", async () => {
    await writeFile(join(project, "AGENTS.md"), "## Perintah\n\nbun test\n");
    const imported = await service.importProjectDocs(project);
    await service.accept(imported.created[0]!.id);

    const current = await readFile(join(project, "AGENTS.md"), "utf8");
    await writeFile(join(project, "AGENTS.md"), `${current}\ntambahan\n`);

    const listed = await service.list({ status: "active" });
    const found = listed.items.find((item) => item.id === imported.created[0]!.id);
    expect(found?.staleReason).toBe("berkas asal berubah");
  });
});
