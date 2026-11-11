import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSandboxStore,
  MAX_LIST_ENTRIES,
  MAX_PATH_LENGTH,
  SandboxConfigError,
  defaultSandboxStore,
} from "../src/server/sandbox/sandbox-config";

let root: string;
let storePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jejak-sandbox-"));
  storePath = join(root, "home", "sandbox.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(): FileSandboxStore {
  return new FileSandboxStore(storePath);
}

const DEFAULTS = {
  mode: "standar" as const,
  allowedDomains: [],
  extraDenyRead: [],
  extraDenyWrite: [],
  extraAllowWrite: [],
  extraAllowUnixSockets: [],
  allowLocalBinding: false,
};

describe("FileSandboxStore", () => {
  test("default standar dengan daftar kosong", () => {
    expect(store().get()).toEqual(DEFAULTS);
  });

  test("set dan persistensi antar instance", async () => {
    const s = store();
    s.set({ mode: "mati", allowedDomains: ["b.test", "a.test"], extraDenyRead: ["~/x"] });
    expect(s.get()).toEqual({
      mode: "mati",
      allowedDomains: ["a.test", "b.test"],
      extraDenyRead: ["~/x"],
      extraDenyWrite: [],
      extraAllowWrite: [],
      extraAllowUnixSockets: [],
      allowLocalBinding: false,
    });

    const reopened = store();
    expect(reopened.get()).toEqual(s.get());
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as { version: number };
    expect(parsed.version).toBe(1);
  });

  test("berkas rusak diperlakukan default dan tidak ditimpa sampai set", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(storePath, "{ bukan json", "utf8");
    const s = store();
    expect(s.get()).toEqual(DEFAULTS);
    expect(await readFile(storePath, "utf8")).toBe("{ bukan json");

    s.set({ mode: "mati" });
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as { version: number };
    expect(parsed.version).toBe(1);
  });

  test("versi asing dan entri rusak disaring", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({ version: 99, mode: "mati", allowedDomains: ["x.test"] }),
      "utf8",
    );
    expect(store().get()).toEqual(DEFAULTS);

    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        mode: "aneh",
        allowedDomains: ["oke.test", "BURUK", "https://salah.test", 42, "oke.test"],
        extraDenyRead: ["/absolut", "relatif", "~/rumah"],
        extraDenyWrite: ["../naik"],
      }),
      "utf8",
    );
    expect(store().get()).toEqual({
      mode: "standar",
      allowedDomains: ["oke.test"],
      extraDenyRead: ["/absolut", "~/rumah"],
      extraDenyWrite: [],
      extraAllowWrite: [],
      extraAllowUnixSockets: [],
      allowLocalBinding: false,
    });
  });

  test("mode berkas 0600 dan direktori 0700", async () => {
    store().set({ mode: "mati" });
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "home"))).mode & 0o777).toBe(0o700);
  });

  test(":memory: bekerja tanpa berkas", () => {
    const s = new FileSandboxStore(":memory:");
    s.set({ mode: "mati" });
    expect(s.get().mode).toBe("mati");
    expect(existsSync(storePath)).toBe(false);
  });

  test("validasi domain", () => {
    const s = new FileSandboxStore(":memory:");
    for (const bad of ["", "A.test", "https://x.test", "x.test:443", "x.test/path", "-awal.test", "x.test."]) {
      expect(() => s.set({ allowedDomains: [bad] })).toThrow(SandboxConfigError);
    }
    expect(s.set({ allowedDomains: ["*.contoh.test", "a-b.test", "x.test"] }).allowedDomains).toEqual([
      "*.contoh.test",
      "a-b.test",
      "x.test",
    ]);
  });

  test("validasi jalur", () => {
    const s = new FileSandboxStore(":memory:");
    for (const bad of ["", "relatif", "../naik", "/a/../b", `/${"a".repeat(MAX_PATH_LENGTH)}`, "/a\u0000b"]) {
      expect(() => s.set({ extraDenyRead: [bad] })).toThrow(SandboxConfigError);
    }
    expect(s.set({ extraDenyWrite: ["~/x", "/abs/y"] }).extraDenyWrite).toEqual(["/abs/y", "~/x"]);
  });

  test("berkas lama tanpa field pelonggaran terbaca dengan default", async () => {
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        mode: "standar",
        allowedDomains: [],
        extraDenyRead: [],
        extraDenyWrite: [],
      }),
      "utf8",
    );
    expect(store().get()).toEqual(DEFAULTS);
  });

  test("validasi jalur tulis tambahan dan socket Unix", () => {
    const s = new FileSandboxStore(":memory:");
    for (const bad of ["/", "~", "~/", "relatif", "/a/../b"]) {
      expect(() => s.set({ extraAllowWrite: [bad] })).toThrow(SandboxConfigError);
      expect(() => s.set({ extraAllowUnixSockets: [bad] })).toThrow(SandboxConfigError);
    }
    for (const bad of ["/tmp/*.sock", "~/run/?.sock"]) {
      expect(() => s.set({ extraAllowUnixSockets: [bad] })).toThrow("wildcard");
    }
    expect(
      s.set({
        extraAllowWrite: ["~/tmp", "/srv/data"],
        extraAllowUnixSockets: ["/var/run/docker.sock", "~/.orbstack/run/docker.sock"],
        allowLocalBinding: true,
      }),
    ).toEqual({
      mode: "standar",
      allowedDomains: [],
      extraDenyRead: [],
      extraDenyWrite: [],
      extraAllowWrite: ["/srv/data", "~/tmp"],
      extraAllowUnixSockets: ["/var/run/docker.sock", "~/.orbstack/run/docker.sock"],
      allowLocalBinding: true,
    });
  });

  test("allowLocalBinding harus boolean", () => {
    const s = new FileSandboxStore(":memory:");
    expect(() =>
      s.set({ allowLocalBinding: "ya" as unknown as boolean }),
    ).toThrow(SandboxConfigError);
    expect(s.set({ allowLocalBinding: false }).allowLocalBinding).toBe(false);
  });

  test("validasi mode dan bentuk patch", () => {
    const s = new FileSandboxStore(":memory:");
    expect(() => s.set({ mode: "nyala" as unknown as "mati" })).toThrow(SandboxConfigError);
    expect(() => s.set({ allowedDomains: "bukan" as unknown as string[] })).toThrow(
      SandboxConfigError,
    );
  });

  test(`batas ${MAX_LIST_ENTRIES} entri`, () => {
    const s = new FileSandboxStore(":memory:");
    const domains = Array.from({ length: MAX_LIST_ENTRIES }, (_, index) => `d${index}.test`);
    expect(() => s.set({ allowedDomains: [...domains, "lebih.test"] })).toThrow("Batas");
    expect(s.set({ allowedDomains: domains }).allowedDomains).toHaveLength(MAX_LIST_ENTRIES);
  });

  test("patch atomik: entri buruk membatalkan seluruh patch", () => {
    const s = new FileSandboxStore(":memory:");
    s.set({ allowedDomains: ["a.test"] });
    expect(() =>
      s.set({ allowedDomains: ["b.test"], extraDenyRead: ["relatif"] }),
    ).toThrow(SandboxConfigError);
    expect(s.get().allowedDomains).toEqual(["a.test"]);
  });

  test("defaultSandboxStore memakai env dan kill switch", () => {
    const env = { JEJAK_HOME: join(root, "home") };
    expect(defaultSandboxStore(env)?.get().mode).toBe("standar");
    expect(defaultSandboxStore({ ...env, JEJAK_SANDBOX: "0" })).toBeUndefined();
    expect(defaultSandboxStore({ ...env, JEJAK_PERSIST: "0" })).toBeDefined();
  });
});
