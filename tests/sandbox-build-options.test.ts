import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_DENY_READ_REL,
  DEFAULT_DENY_WRITE_REL,
  buildSandboxOptions,
  describeSandboxFailure,
  extractSandboxViolations,
  isSafeWritePath,
  providerHostsFrom,
  sandboxAvailable,
} from "../src/server/sandbox/build-options";
import type { SandboxConfig } from "../src/server/sandbox/sandbox-config";

const HOME = "/rumah/uji";
const JEJAK = "/rumah/uji/.jejak";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: "standar",
    allowedDomains: [],
    extraDenyRead: [],
    extraDenyWrite: [],
    extraAllowWrite: [],
    extraAllowUnixSockets: [],
    allowLocalBinding: false,
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildSandboxOptions>[0]> = {}) {
  return buildSandboxOptions({
    mode: "standar",
    config: config(),
    home: HOME,
    jejakHome: JEJAK,
    projectRoots: ["/proyek"],
    extraWriteDirs: ["/proyek"],
    providerHosts: [],
    ...overrides,
  });
}

type Options = {
  enabled: boolean;
  failIfUnavailable: boolean;
  allowUnsandboxedCommands: boolean;
  autoAllowBashIfSandboxed: boolean;
  filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
  network: {
    allowedDomains: string[];
    strictAllowlist: boolean;
    allowLocalBinding: boolean;
    allowUnixSockets?: string[];
  };
};

describe("buildSandboxOptions", () => {
  test("mode mati menghasilkan undefined", () => {
    expect(build({ mode: "mati" })).toBeUndefined();
  });

  test("flag wajib sandbox standar", () => {
    const options = build() as Options;
    expect(options.enabled).toBe(true);
    expect(options.failIfUnavailable).toBe(true);
    expect(options.allowUnsandboxedCommands).toBe(false);
    expect(options.autoAllowBashIfSandboxed).toBe(true);
    expect(options.network.strictAllowlist).toBe(true);
    expect(options.network.allowLocalBinding).toBe(false);
  });

  test("denyWrite per akar proyek termasuk worktree dan repoRoot", () => {
    const options = build({
      projectRoots: ["/proyek/worktree", "/proyek/asli"],
      extraWriteDirs: ["/proyek/asli", "/proyek/worktree"],
    }) as Options;
    for (const root of ["/proyek/worktree", "/proyek/asli"]) {
      for (const rel of DEFAULT_DENY_WRITE_REL) {
        expect(options.filesystem.denyWrite).toContain(join(root, rel));
      }
    }
    expect(options.filesystem.denyWrite).toContain("/proyek/asli/.git/hooks");
    expect(options.filesystem.allowWrite).toEqual(["/proyek/asli", "/proyek/worktree"]);
  });

  test("denyRead bawaan, jejakHome, dan ekspansi ~", () => {
    const options = build({
      config: config({ extraDenyRead: ["~/rahasia", "/abs/rahasia"] }),
    }) as Options;
    for (const rel of DEFAULT_DENY_READ_REL) {
      expect(options.filesystem.denyRead).toContain(join(HOME, rel));
    }
    expect(options.filesystem.denyRead).toContain(JEJAK);
    expect(options.filesystem.denyRead).toContain(join(HOME, "rahasia"));
    expect(options.filesystem.denyRead).toContain("/abs/rahasia");
  });

  test("denyWrite tambahan diekspansi dari ~", () => {
    const options = build({
      config: config({ extraDenyWrite: ["~/kunci"] }),
    }) as Options;
    expect(options.filesystem.denyWrite).toContain(join(HOME, "kunci"));
  });

  test("tanpa duplikat dan urutan deterministik", () => {
    const options = build({
      projectRoots: ["/proyek", "/proyek"],
      extraWriteDirs: ["/proyek", "/proyek"],
      providerHosts: ["github.com", "api.test"],
    }) as Options;
    const write = options.filesystem.allowWrite;
    expect(write).toEqual([...new Set(write)]);
    const domains = options.network.allowedDomains;
    expect(domains).toEqual([...new Set(domains)]);
    expect(options.filesystem.denyWrite).toEqual([...new Set(options.filesystem.denyWrite)]);
    expect(options.filesystem.denyWrite).toEqual([...options.filesystem.denyWrite].sort());
  });

  test("domain bawaan + tambahan + host provider", () => {
    const options = build({
      config: config({ allowedDomains: ["api.tambahan.test"] }),
      providerHosts: ["api.provider.test"],
    }) as Options;
    for (const domain of DEFAULT_ALLOWED_DOMAINS) {
      expect(options.network.allowedDomains).toContain(domain);
    }
    expect(options.network.allowedDomains).toContain("api.tambahan.test");
    expect(options.network.allowedDomains).toContain("api.provider.test");
  });

  test("config default tidak menambah kunci socket maupun melonggarkan binding", () => {
    const options = build() as Options;
    expect("allowUnixSockets" in options.network).toBe(false);
    expect(options.network.allowLocalBinding).toBe(false);
    expect(options.filesystem.allowWrite).toEqual(["/proyek"]);
  });

  test("extraAllowWrite, socket, dan allowLocalBinding diteruskan", () => {
    const options = build({
      config: config({
        extraAllowWrite: ["~/tmp/proyek", "/srv/data"],
        extraAllowUnixSockets: ["~/.orbstack/run/docker.sock", "/var/run/docker.sock"],
        allowLocalBinding: true,
      }),
    }) as Options;
    expect(options.filesystem.allowWrite).toEqual([
      "/proyek",
      join(HOME, "tmp/proyek"),
      "/srv/data",
    ]);
    expect(options.network.allowUnixSockets).toEqual([
      join(HOME, ".orbstack/run/docker.sock"),
      "/var/run/docker.sock",
    ]);
    expect(options.network.allowLocalBinding).toBe(true);
  });

  test("entri tulis berbahaya dibuang", () => {
    const options = build({
      config: config({
        extraAllowWrite: [
          "/rumah/uji",
          "/rumah",
          "~",
          JEJAK,
          join(JEJAK, "provider.json"),
          "/rumah/uji/.ssh",
          "/srv/aman",
        ],
        extraAllowUnixSockets: [join(JEJAK, "rahasia.sock"), "/var/run/docker.sock"],
      }),
    }) as Options;
    expect(options.filesystem.allowWrite).toEqual(["/proyek", "/srv/aman"]);
    expect(options.network.allowUnixSockets).toEqual(["/var/run/docker.sock"]);
  });
});

describe("isSafeWritePath", () => {
  const guard = { home: HOME, jejakHome: JEJAK, denyRead: [join(HOME, ".ssh")] };

  test("menolak home, jejakHome, leluhur, dan isi jejakHome", () => {
    for (const path of [
      "/",
      HOME,
      "/rumah",
      JEJAK,
      join(JEJAK, "audit.db"),
      join(HOME, ".ssh"),
      join(HOME, ".ssh", "authorized_keys"),
    ]) {
      expect(isSafeWritePath(path, guard)).toBe(false);
    }
  });

  test("menerima jalur spesifik di luar jalur sensitif", () => {
    expect(isSafeWritePath(join(HOME, "tmp"), guard)).toBe(true);
    expect(isSafeWritePath("/srv/data", guard)).toBe(true);
  });
});

describe("providerHostsFrom", () => {
  test("URL valid menghasilkan hostname", () => {
    expect(providerHostsFrom("https://API.Contoh.test/v1")).toEqual(["api.contoh.test"]);
    expect(providerHostsFrom("http://127.0.0.1:8080")).toEqual(["127.0.0.1"]);
  });

  test("URL kosong atau tak valid menghasilkan daftar kosong", () => {
    expect(providerHostsFrom()).toEqual([]);
    expect(providerHostsFrom("")).toEqual([]);
    expect(providerHostsFrom("bukan url")).toEqual([]);
  });
});

describe("extractSandboxViolations", () => {
  test("mengambil baris di dalam blok, rapi, maks 5", () => {
    const text = [
      "gagal",
      "<sandbox_violations>",
      "  deny network-outbound   example.org:443 (host is not on the allow list)  ",
      "",
      "deny file-write* /luar",
      "baris tiga",
      "baris empat",
      "baris lima",
      "baris enam",
      "</sandbox_violations>",
    ].join("\n");
    const lines = extractSandboxViolations(text);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("deny network-outbound example.org:443 (host is not on the allow list)");
  });

  test("tanpa blok menghasilkan kosong", () => {
    expect(extractSandboxViolations("biasa saja")).toEqual([]);
    expect(extractSandboxViolations("")).toEqual([]);
  });

  test("baris dipotong 200 karakter", () => {
    const line = "x".repeat(300);
    expect(extractSandboxViolations(`<sandbox_violations>${line}</sandbox_violations>`)[0]).toHaveLength(200);
  });
});

describe("sandboxAvailable", () => {
  test("darwin memakai sandbox-exec", () => {
    const ok = sandboxAvailable("darwin", (name) => (name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null));
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("sandbox-exec");
    const missing = sandboxAvailable("darwin", () => null);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("sandbox-exec");
  });

  test("linux memakai bwrap dan melaporkan socat tanpa gagal", () => {
    const withoutSocat = sandboxAvailable("linux", (name) => (name === "bwrap" ? "/usr/bin/bwrap" : null));
    expect(withoutSocat.ok).toBe(true);
    expect(withoutSocat.detail).toContain("socat");
    const complete = sandboxAvailable("linux", (name) => `/usr/bin/${name}`);
    expect(complete.ok).toBe(true);
    const missing = sandboxAvailable("linux", () => null);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("bwrap");
  });

  test("platform lain tidak didukung", () => {
    const win = sandboxAvailable("win32", () => null);
    expect(win.ok).toBe(false);
    expect(win.detail).toContain("tidak tersedia di Windows");

    const result = sandboxAvailable("freebsd", () => null);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("freebsd");
  });
});

describe("describeSandboxFailure", () => {
  test("menambah petunjuk hanya bila pesan menyebut sandbox", () => {
    const hint = describeSandboxFailure("sandbox tidak tersedia");
    expect(hint).toContain("jejak doctor");
    expect(describeSandboxFailure("galat provider biasa")).toBeUndefined();
    expect(describeSandboxFailure("Sandbox gagal disiapkan")).toBeDefined();
  });
});
