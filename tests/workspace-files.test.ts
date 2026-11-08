import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteWorkspaceFile,
  initialServiceCard,
  isWorkspaceId,
  parseServiceCard,
  parseWorkspace,
  readWorkspaceFile,
  scanWorkspaceFiles,
  serializeWorkspace,
  workspacesDir,
  workspaceFilePath,
  writeWorkspaceFile,
  type Workspace,
} from "../src/server/workspaces/workspace-files";

let dir: string;
let repoDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-workspace-files-"));
  repoDir = await mkdtemp(join(tmpdir(), "jejak-workspace-repo-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  const at = "2026-11-08T10:00:00.000Z";
  return {
    id: crypto.randomUUID(),
    name: "Kantor",
    createdAt: at,
    updatedAt: at,
    repos: [
      {
        name: "api",
        path: repoDir,
        card: {
          description: "Layanan utama",
          kind: "backend",
          tables: ["pesanan", "pengguna"],
          queues: ["antrian-pesanan"],
          calls: ["web"],
          updatedAt: at,
        },
      },
    ],
    ...overrides,
  };
}

describe("workspacesDir", () => {
  test("memakai JEJAK_HOME dan default ~/.jejak", () => {
    expect(workspacesDir({ JEJAK_HOME: "/tmp/rumah" })).toBe("/tmp/rumah/workspaces");
    expect(workspacesDir({}).endsWith("/workspaces")).toBe(true);
  });
});

describe("validasi id", () => {
  test("UUID v4 diterima, bentuk lain ditolak", () => {
    expect(isWorkspaceId(crypto.randomUUID())).toBe(true);
    expect(isWorkspaceId("../../../etc/passwd")).toBe(false);
    expect(isWorkspaceId("00000000-0000-3000-8000-000000000000")).toBe(false);
  });

  test("workspaceFilePath menolak ../x dan nama bukan UUID", () => {
    expect(workspaceFilePath(dir, "../x.json")).toBeNull();
    expect(workspaceFilePath(dir, "bukan-uuid.json")).toBeNull();
    expect(workspaceFilePath(dir, `${crypto.randomUUID()}.json`)).not.toBeNull();
  });
});

describe("round-trip berkas", () => {
  test("tulis lalu baca mengembalikan isi yang sama", async () => {
    const item = workspace();
    await writeWorkspaceFile(dir, item);
    const read = await readWorkspaceFile(dir, `${item.id}.json`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.workspace).toEqual(item);
  });

  test("serialisasi memakai version 1 dan dapat di-parse ulang", () => {
    const item = workspace();
    const text = serializeWorkspace(item);
    expect(JSON.parse(text).version).toBe(1);
    const parsed = parseWorkspace(text, `${item.id}.json`);
    expect(parsed.ok).toBe(true);
  });

  test("berkas 0600 dan direktori 0700, tanpa sisa tmp", async () => {
    const item = workspace();
    await writeWorkspaceFile(dir, item);
    const fileInfo = await stat(join(dir, `${item.id}.json`));
    const dirInfo = await stat(dir);
    expect(fileInfo.mode & 0o777).toBe(0o600);
    expect(dirInfo.mode & 0o777).toBe(0o700);
    const names = await readdir(dir);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("delete menghapus hanya berkas workspace", async () => {
    const item = workspace();
    await writeWorkspaceFile(dir, item);
    expect(await deleteWorkspaceFile(dir, item.id)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    expect(await deleteWorkspaceFile(dir, item.id)).toBe(false);
  });
});

describe("berkas rusak", () => {
  async function writeInvalid(id: string, content: string): Promise<string> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${id}.json`), content, { mode: 0o600 });
    return `${id}.json`;
  }

  test("JSON invalid dilaporkan ok:false tanpa isi", async () => {
    const id = crypto.randomUUID();
    const fileName = await writeInvalid(id, "{ bukan json");
    const read = await readWorkspaceFile(dir, fileName);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).not.toContain("bukan json");
  });

  test("version salah ditolak", async () => {
    const item = workspace();
    const id = item.id;
    const fileName = await writeInvalid(id, JSON.stringify({ ...item, version: 2 }));
    const read = await readWorkspaceFile(dir, fileName);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain("versi");
  });

  test("id tidak cocok nama berkas ditolak", async () => {
    const item = workspace();
    const fileName = await writeInvalid(
      crypto.randomUUID(),
      JSON.stringify({ ...item, version: 1 }),
    );
    const read = await readWorkspaceFile(dir, fileName);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain("nama berkas");
  });

  test("field terlalu panjang ditolak", async () => {
    const item = workspace({ name: "x".repeat(81) });
    const fileName = await writeInvalid(item.id, JSON.stringify({ ...item, version: 1 }));
    const read = await readWorkspaceFile(dir, fileName);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain("name");
  });

  test("enum kind salah ditolak", async () => {
    const item = workspace();
    item.repos[0]!.card.kind = "entah" as never;
    const fileName = await writeInvalid(item.id, JSON.stringify({ ...item, version: 1 }));
    const read = await readWorkspaceFile(dir, fileName);
    expect(read.ok).toBe(false);
  });

  test("berkas valid dan rusak: yang valid tetap terbaca, rusak masuk problems", async () => {
    const good = workspace();
    await writeWorkspaceFile(dir, good);
    await writeFile(join(dir, `${crypto.randomUUID()}.json`), "rusak", { mode: 0o600 });

    const scanned = await scanWorkspaceFiles(dir);
    expect(scanned.items.map((item) => item.id)).toEqual([good.id]);
    expect(scanned.problems).toHaveLength(1);
    expect(scanned.problems[0]?.file.endsWith(".json")).toBe(true);
  });

  test("folder belum ada menghasilkan daftar kosong", async () => {
    const scanned = await scanWorkspaceFiles(join(dir, "tidak-ada"));
    expect(scanned).toEqual({ items: [], problems: [] });
  });
});

describe("parse kartu service", () => {
  test("kartu awal valid", () => {
    const parsed = parseServiceCard(initialServiceCard());
    expect(parsed.ok).toBe(true);
  });

  test("daftar terlalu panjang dan entri terlalu panjang ditolak", () => {
    const base = initialServiceCard();
    expect(parseServiceCard({ ...base, tables: Array.from({ length: 101 }, () => "t") }).ok).toBe(
      false,
    );
    expect(parseServiceCard({ ...base, queues: ["x".repeat(121)] }).ok).toBe(false);
  });

  test("duplikat dibuang saat parse", () => {
    const parsed = parseServiceCard({ ...initialServiceCard(), calls: ["a", "a", " b "] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.card.calls).toEqual(["a", "b"]);
  });

  test("rahasia pada kartu ditolak tanpa mengulang teks", async () => {
    const secret = "ghp_abcdefghijklmnopqrst";
    const parsed = parseServiceCard({ ...initialServiceCard(), description: `token ${secret}` });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("rahasia");
    expect(parsed.reason).not.toContain(secret);
  });
});
