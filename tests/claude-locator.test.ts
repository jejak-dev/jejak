import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_PATH_ENV,
  claudeSettingPath,
  commonClaudePaths,
  defaultRunVersion,
  invalidateClaudeCache,
  locateClaude,
  readClaudeSetting,
  validateClaudePath,
  writeClaudeSetting,
  type LocateOptions,
  resolveWindowsShim,
} from "../src/server/sdk/claude-locator";

let dir: string;
let home: string;
let env: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-claude-"));
  home = join(dir, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  env = { JEJAK_HOME: home };
  invalidateClaudeCache();
});

afterEach(async () => {
  invalidateClaudeCache();
  await rm(dir, { recursive: true, force: true });
});

/** Opsi locate dengan semua sumber ada tapi panggilan Versi dikendalikan. */
function opsi(
  overrides: Partial<LocateOptions> & {
    whichPath?: string | null;
    version?: (path: string) => string | null;
    exists?: (path: string) => Promise<boolean>;
  } = {},
): LocateOptions {
  const {
    whichPath = null,
    version = () => "2.1.0 (Claude Code)",
    exists = async () => true,
    ...rest
  } = overrides;
  return {
    env,
    home: join(dir, "user"),
    platform: "linux",
    which: () => whichPath,
    exists,
    runVersion: async (path: string) => version(path),
    ...rest,
  };
}

/** Skrip shell sementara yang bisa dijalankan. */
async function skrip(nama: string, isi: string): Promise<string> {
  const path = join(dir, nama);
  await writeFile(path, isi, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("validateClaudePath", () => {
  test("menerima jalur absolut", () => {
    expect(validateClaudePath("/usr/local/bin/claude")).toEqual({ ok: true });
  });

  test("menolak jalur relatif", () => {
    const hasil = validateClaudePath("bin/claude");
    expect(hasil.ok).toBe(false);
    expect(hasil.ok === false && hasil.reason).toBe("bukan-absolut");
  });

  test("menolak NUL dan karakter kontrol", () => {
    for (const buruk of ["/bin/cla\u0000ude", "/bin/cla\nude", "/bin/cla\u007fude"]) {
      const hasil = validateClaudePath(buruk);
      expect(hasil.ok).toBe(false);
      expect(hasil.ok === false && hasil.reason).toBe("karakter-kontrol");
    }
  });

  test("menolak yang bukan teks dan terlalu panjang", () => {
    expect(validateClaudePath(42).ok).toBe(false);
    expect(validateClaudePath(`/${"a".repeat(2000)}`).ok).toBe(false);
  });
});

describe("commonClaudePaths", () => {
  test("macOS dan linux memakai lokasi umum", () => {
    const paths = commonClaudePaths("/home/u", "linux");
    expect(paths).toContain("/home/u/.local/bin/claude");
    expect(paths).toContain("/opt/homebrew/bin/claude");
    expect(paths).toContain("/usr/local/bin/claude");
    expect(paths).toContain("/home/u/.claude/local/claude");
  });

  test("windows memakai lokasi miliknya sendiri", () => {
    const paths = commonClaudePaths("C:\\Users\\u", "win32");
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("claude.exe");
    expect(paths[1]).toContain("claude.cmd");
  });
});

describe("locateClaude", () => {
  test("env menang atas pengaturan, PATH, dan lokasi umum", async () => {
    await writeClaudeSetting("/setting/claude", env);
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/env/claude" },
      }),
    );
    expect(lokasi?.source).toBe("env");
    expect(lokasi?.path).toBe("/env/claude");
  });

  test("pengaturan menang atas PATH dan lokasi umum", async () => {
    await writeClaudeSetting("/setting/claude", env);
    const lokasi = await locateClaude(opsi({ whichPath: "/which/claude" }));
    expect(lokasi?.source).toBe("setting");
    expect(lokasi?.path).toBe("/setting/claude");
  });

  test("PATH menang atas lokasi umum", async () => {
    const lokasi = await locateClaude(opsi({ whichPath: "/which/claude" }));
    expect(lokasi?.source).toBe("path");
    expect(lokasi?.path).toBe("/which/claude");
  });

  test("lokasi umum dipakai sebagai pilihan terakhir", async () => {
    const common = commonClaudePaths(join(dir, "user"), "linux")[0] as string;
    const lokasi = await locateClaude(
      opsi({ exists: async (path) => path === common }),
    );
    expect(lokasi?.source).toBe("common");
    expect(lokasi?.path).toBe(common);
  });

  test("env kosong diabaikan", async () => {
    const lokasi = await locateClaude(
      opsi({ whichPath: "/which/claude", env: { ...env, [CLAUDE_PATH_ENV]: "  " } }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("jalur relatif dilewati dan pencarian lanjut", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "bin/claude" },
      }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("jalur berkarakter kontrol dilewati", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/bin/cla\u0000ude" },
      }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("kandidat yang gagal --version dilewati", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/env/claude" },
        version: (path) => (path === "/env/claude" ? null : "2.1.0"),
      }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("kandidat yang tidak ada dilewati", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/env/claude" },
        exists: async (path) => path !== "/env/claude",
      }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("kandidat duplikat dicoba sekali", async () => {
    let dipanggil = 0;
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/sama/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/sama/claude" },
        version: () => {
          dipanggil += 1;
          return "2.1.0";
        },
      }),
    );
    expect(lokasi?.source).toBe("env");
    expect(dipanggil).toBe(1);
  });

  test("tidak melempar saat semua kandidat gagal", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/env/claude" },
        exists: async () => false,
        version: () => null,
      }),
    );
    expect(lokasi).toBeNull();
  });

  test("pencarian tidak melempar meski exists dan runVersion gagal", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        exists: async () => {
          throw new Error("boom");
        },
        runVersion: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(lokasi).toBeNull();
  });
});

describe("defaultRunVersion", () => {
  test("membaca versi dari keluaran --version", async () => {
    const path = await skrip("claude-versi.sh", '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
    expect(await defaultRunVersion(path, 5000)).toBe("2.1.0 (Claude Code)");
  });

  test("keluaran tanpa versi dianggap gagal", async () => {
    const path = await skrip("claude-isi.sh", "#!/bin/sh\necho \"apa saja\"\n");
    expect(await defaultRunVersion(path, 5000)).toBeNull();
  });

  test("kode keluar bukan 0 dianggap gagal", async () => {
    const path = await skrip("claude-gagal.sh", "#!/bin/sh\nexit 1\n");
    expect(await defaultRunVersion(path, 5000)).toBeNull();
  });

  test("keluar lebih dari 200 karakter dipangkas", async () => {
    const path = await skrip(
      "claude-panjang.sh",
      `#!/bin/sh\nprintf '1.2.3%s\\n' "$(head -c 300 /dev/zero | tr '\\0' 'x')"\n`,
    );
    const hasil = await defaultRunVersion(path, 5000);
    expect(hasil).not.toBeNull();
    expect((hasil as string).length).toBeLessThanOrEqual(200);
  });

  test("timeout membunuh proses dan hasilnya null", async () => {
    const penanda = join(dir, "penanda.txt");
    const path = await skrip(
      "claude-lama.sh",
      `#!/bin/sh\nsleep 0.5\necho selesai > "${penanda}"\n`,
    );
    const mulai = Date.now();
    expect(await defaultRunVersion(path, 200)).toBeNull();
    expect(Date.now() - mulai).toBeLessThan(2000);
    await Bun.sleep(1200);
    expect(existsSync(penanda)).toBe(false);
  });

  test("berkas yang tidak ada tidak melempar", async () => {
    expect(await defaultRunVersion(join(dir, "tidak-ada"), 500)).toBeNull();
  });
});

describe("berkas pengaturan jalur", () => {
  test("lokasi berkas mengikuti JEJAK_HOME", () => {
    expect(claudeSettingPath({ JEJAK_HOME: "/tmp/jejak" })).toBe(
      join("/tmp/jejak", "claude-path.json"),
    );
  });

  test("tulis dan baca bolak-balik", async () => {
    await writeClaudeSetting("/usr/local/bin/claude", env);
    expect(await readClaudeSetting(env)).toBe("/usr/local/bin/claude");
    const isi = JSON.parse(
      await readFile(claudeSettingPath(env), "utf8"),
    ) as { path: string };
    expect(isi.path).toBe("/usr/local/bin/claude");
  });

  test("mode berkas 0600 dan direktori 0700", async () => {
    await writeClaudeSetting("/usr/local/bin/claude", env);
    const info = await stat(claudeSettingPath(env));
    expect(info.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(home);
    expect(dirInfo.mode & 0o777).toBe(0o700);
  });

  test("berkas rusak dibaca sebagai null", async () => {
    await writeFile(claudeSettingPath(env), "{bukan json", "utf8");
    expect(await readClaudeSetting(env)).toBeNull();
  });

  test("berkas tanpa path string dibaca sebagai null", async () => {
    await writeFile(claudeSettingPath(env), JSON.stringify({ path: 42 }), "utf8");
    expect(await readClaudeSetting(env)).toBeNull();
  });

  test("berkas tak ada dibaca sebagai null", async () => {
    expect(await readClaudeSetting({ JEJAK_HOME: join(dir, "kosong") })).toBeNull();
  });

  test("null menghapus berkas dan mengabaikan berkas yang tak ada", async () => {
    await writeClaudeSetting("/usr/local/bin/claude", env);
    await writeClaudeSetting(null, env);
    expect(existsSync(claudeSettingPath(env))).toBe(false);
    await writeClaudeSetting(null, env);
    expect(await readClaudeSetting(env)).toBeNull();
  });
});

describe("locateClaude dengan CLI bawaan SDK", () => {
  test("CLI terkelola menang atas PATH dan lokasi umum", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        managed: async () => ({ path: "/sdk/cli/claude", version: "2.1.0" }),
      }),
    );
    expect(lokasi?.source).toBe("managed");
    expect(lokasi?.path).toBe("/sdk/cli/claude");
  });

  test("CLI terkelola kalah oleh env dan pengaturan", async () => {
    await writeClaudeSetting("/setting/claude", env);
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        env: { ...env, [CLAUDE_PATH_ENV]: "/env/claude" },
        managed: async () => ({ path: "/sdk/cli/claude", version: "2.1.0" }),
      }),
    );
    expect(lokasi?.source).toBe("env");
  });

  test("pengaturan menang atas CLI terkelola", async () => {
    await writeClaudeSetting("/setting/claude", env);
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        managed: async () => ({ path: "/sdk/cli/claude", version: "2.1.0" }),
      }),
    );
    expect(lokasi?.source).toBe("setting");
  });

  test("CLI terkelola yang null dilewati", async () => {
    const lokasi = await locateClaude(
      opsi({ whichPath: "/which/claude", managed: async () => null }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("CLI terkelola yang gagal tidak menggagalkan pencarian", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        managed: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(lokasi?.source).toBe("path");
  });

  test("CLI terkelola yang tidak ada dilewati", async () => {
    const lokasi = await locateClaude(
      opsi({
        whichPath: "/which/claude",
        managed: async () => ({ path: "/sdk/cli/claude", version: "2.1.0" }),
        exists: async (path) => path !== "/sdk/cli/claude",
      }),
    );
    expect(lokasi?.source).toBe("path");
  });
});

describe("resolveWindowsShim", () => {
  const shim = "C:\\Users\\boyku\\AppData\\Roaming\\npm\\claude.cmd";
  const exe = "C:\\Users\\boyku\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  const js = "C:\\Users\\boyku\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";

  test("memilih claude.exe di samping shim", async () => {
    const hasil = await resolveWindowsShim(shim, async (p) => p === exe || p === js, "win32");
    expect(hasil).toBe(exe);
  });

  test("jatuh ke cli.js bila exe tak ada", async () => {
    expect(await resolveWindowsShim(shim, async (p) => p === js, "win32")).toBe(js);
  });

  test("tanpa target, jalur asli dikembalikan", async () => {
    expect(await resolveWindowsShim(shim, async () => false, "win32")).toBe(shim);
  });

  test("bukan Windows atau bukan .cmd tak diubah", async () => {
    expect(await resolveWindowsShim(shim, async () => true, "darwin")).toBe(shim);
    expect(await resolveWindowsShim("C:\\x\\claude.exe", async () => true, "win32")).toBe("C:\\x\\claude.exe");
  });
});
