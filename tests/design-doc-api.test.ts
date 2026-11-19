import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server";
import { createMockRunner } from "../src/server/agent";
import { SqliteAuditStore, type AuditStore } from "../src/server/audit/audit-store";
import { AUTO_END, AUTO_START } from "../src/server/design/design-doc";

let dir: string;
let providersFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-doc-api-"));
  const configDir = await mkdtemp(join(tmpdir(), "jejak-design-doc-api-config-"));
  providersFile = join(configDir, "providers.json");
  await writeFile(
    providersFile,
    JSON.stringify({
      profiles: [
        {
          id: "lokal",
          name: "Lokal",
          baseUrl: "https://lokal.test",
          apiKey: "sk-rahasia",
          models: [{ id: "mock-model" }],
          defaultModel: "mock-model",
        },
      ],
      activeProfileId: "lokal",
    }),
    "utf8",
  );
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await writeFile(
    join(dir, "design", "design.json"),
    `${JSON.stringify(
      {
        version: 1,
        pages: [{ slug: "beranda", title: "Beranda", device: "desktop", x: 0, y: 0 }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(dir, "design", "tokens.css"), ":root {\n  --warna-aksen: #2f6fed;\n}\n", "utf8");
  await writeFile(join(dir, "design", "pages", "beranda.html"), "<html></html>", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;

function makeApp(extra: Record<string, string> = {}, audit?: AuditStore): App {
  return createApp({
    providersPath: providersFile,
    env: { MOCK: "true", JEJAK_HOME: join(dir, "home"), ...extra },
    runner: createMockRunner(),
    ...(audit === undefined ? {} : { audit }),
  });
}

function req(server: App, method: string, path: string): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000" },
    }),
  );
}

function reqBody(server: App, method: string, path: string, body: unknown): Promise<Response> {
  return server.handle(
    new Request(`http://127.0.0.1:3000${path}`, {
      method,
      headers: { host: "127.0.0.1:3000", "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function createSession(server: App, cwd = dir): Promise<string> {
  const created = await reqBody(server, "POST", "/api/sessions", { prompt: "Halo", cwd });
  expect(created.status).toBe(201);
  const data = (await created.json()) as { session: { id: string } };
  const id = data.session.id;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const detail = await req(server, "GET", `/api/sessions/${id}`);
    const status = ((await detail.json()) as { session: { status: string } }).session.status;
    if (status !== "berjalan") break;
    await Bun.sleep(5);
  }
  return id;
}

function docPath(cwd = dir): string {
  return join(cwd, "design", "DESIGN.md");
}

async function isiDoc(cwd = dir): Promise<string> {
  return readFile(docPath(cwd), "utf8");
}

interface ErrorBody {
  error: string;
}

describe("rute dokumen desain", () => {
  test("POST membuat blok lalu idempoten", async () => {
    const server = makeApp();
    const id = await createSession(server);
    const base = `/api/sessions/${id}/design/doc`;

    const pertama = await reqBody(server, "POST", base, {});
    expect(pertama.status).toBe(200);
    expect(await pertama.json()).toEqual({ changed: true });

    const isi = await isiDoc();
    expect(isi).toContain(AUTO_START);
    expect(isi).toContain(AUTO_END);
    expect(isi).toContain("| `--warna-aksen` | `#2f6fed` |");
    expect(isi).toContain("| `beranda` | Beranda | desktop |");

    const kedua = await reqBody(server, "POST", base, {});
    expect(kedua.status).toBe(200);
    expect(await kedua.json()).toEqual({ changed: false });
  });

  test("sesi tak ada 404 dan desain belum dibuat 404", async () => {
    const server = makeApp();
    await createSession(server);

    expect((await reqBody(server, "POST", "/api/sessions/s_tidakada/design/doc", {})).status).toBe(404);

    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-doc-api-kosong-"));
    try {
      const lainId = await createSession(server, kosong);
      const lain = await reqBody(server, "POST", `/api/sessions/${lainId}/design/doc`, {});
      expect(lain.status).toBe(404);
      expect(((await lain.json()) as ErrorBody).error).toBe("Desain belum dibuat.");
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });

  test("editEnabled=false: POST 403", async () => {
    const server = makeApp({ JEJAK_FILE_EDIT: "0" });
    const id = await createSession(server);
    const response = await reqBody(server, "POST", `/api/sessions/${id}/design/doc`, {});
    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorBody).error).toBe("Penyuntingan berkas dimatikan.");
  });

  test("audit tercatat tanpa isi dokumen", async () => {
    const audit = new SqliteAuditStore(":memory:");
    try {
      const server = makeApp({}, audit);
      const id = await createSession(server);
      await reqBody(server, "POST", `/api/sessions/${id}/design/doc`, {});

      const entries = audit.list({ kind: "berkas", limit: 50 }).filter(
        (entry) => entry.meta.aksi === "design-doc",
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.summary).toBe("Dokumen desain diperbarui");
      const json = JSON.stringify(entries);
      expect(json).not.toContain("#2f6fed");
      expect(json).not.toContain("beranda");
    } finally {
      audit.close();
    }
  });

  test("PUT token memperbarui blok otomatis", async () => {
    const server = makeApp();
    const id = await createSession(server);
    await reqBody(server, "PUT", `/api/sessions/${id}/design/tokens`, {
      tokens: [{ name: "--warna-kustom", value: "#00ff00" }],
    });

    const isi = await isiDoc();
    expect(isi).toContain(AUTO_START);
    expect(isi).toContain("| `--warna-kustom` | `#00ff00` |");
  });

  test("PUT tata letak memperbarui blok otomatis", async () => {
    const server = makeApp();
    const id = await createSession(server);
    await reqBody(server, "PUT", `/api/sessions/${id}/design/layout`, {
      pages: [{ slug: "beranda", x: 200, y: 0, device: "mobile" }],
    });

    const isi = await isiDoc();
    expect(isi).toContain(AUTO_START);
    expect(isi).toContain("| `beranda` | Beranda | mobile |");
  });

  test("init membuat DESIGN.md dengan blok otomatis", async () => {
    const server = makeApp();
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-doc-api-init-"));
    try {
      const id = await createSession(server, kosong);
      const dibuat = await reqBody(server, "POST", `/api/sessions/${id}/design/init`, {});
      expect(dibuat.status).toBe(201);

      const isi = await isiDoc(kosong);
      expect(isi).toContain("# Aturan Desain");
      expect(isi).toContain(AUTO_START);
      expect(isi).toContain(AUTO_END);
      expect(isi).toContain("| `--warna-latar` | `#f7f7f8` |");
      expect(isi).toContain("| `contoh` | Contoh | desktop |");
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });
});
