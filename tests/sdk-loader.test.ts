import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSdkLoader,
  detectCompiled,
  SDK_NOT_INSTALLED_MESSAGE,
  SdkBrokenInstallError,
  SdkNotInstalledError,
  type SdkModule,
} from "../src/server/sdk/sdk-loader";
import { createSdkRunner } from "../src/server/agent/sdk-runner";
import type { AgentEvent, RunInput } from "../src/server/agent/events";
import type { ResolvedProvider } from "../src/server/provider";

const VERSI = "0.1.0";
const VERSI_LAIN = "0.2.0";

const PROVIDER: ResolvedProvider = {
  profileId: "proxy",
  baseUrl: "https://proxy.test/v1",
  apiKey: "sk-palsu",
  model: "model-profil",
};

/** Direktori sementara untukJEJAK_HOME; dibersihkan saat tes selesai. */
async function akarSementara(): Promise<{ path: string; selesai: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "jejak-sdk-loader-"));
  return {
    path,
    selesai: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Membuat struktur SDK terkelola: `<root>/<versi>/package/sdk.mjs` + `active.json`. */
async function buatTerkelola(
  root: string,
  versi: string,
  isi = "export function query() {}\n",
): Promise<string> {
  const folder = join(root, versi, "package");
  await mkdir(folder, { recursive: true });
  const berkas = join(folder, "sdk.mjs");
  await writeFile(berkas, isi);
  await writeFile(
    join(root, "active.json"),
    `${JSON.stringify({
      version: versi,
      installedAt: "2026-01-01T00:00:00.000Z",
      integrity: "sha512-dummy",
    })}\n`,
  );
  return berkas;
}

function modulPalsu(): SdkModule {
  return { query: () => ({ async *[Symbol.asyncIterator]() {} }) };
}

test("SDK terkelola menang atas impor bare", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });
    const berkas = await buatTerkelola(root, VERSI);

    const urlDipakai: string[] = [];
    let bareDipanggil = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importFile: async (url) => {
        urlDipakai.push(url);
        return modulPalsu();
      },
      importBare: async () => {
        bareDipanggil += 1;
        return modulPalsu();
      },
    });

    const hasil = await load();
    expect(typeof hasil.query).toBe("function");
    expect(bareDipanggil).toBe(0);
    expect(urlDipakai).toHaveLength(1);
    expect(urlDipakai[0]).toBe(`${pathToFileURL(await realpath(berkas)).href}?v=${VERSI}`);
  } finally {
    await home.selesai();
  }
});

test("impor bare dipakai bila tidak ada SDK terkelola dan bukan binary", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });

    let bareDipanggil = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importFile: async () => {
        throw new Error("impor berkas tidak boleh dipakai");
      },
      importBare: async () => {
        bareDipanggil += 1;
        return modulPalsu();
      },
    });

    const hasil = await load();
    expect(typeof hasil.query).toBe("function");
    expect(bareDipanggil).toBe(1);
  } finally {
    await home.selesai();
  }
});

test("binary tanpa SDK terkelola menghasilkan SdkNotInstalledError", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });

    let bareDipanggil = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => true,
      importFile: async () => {
        throw new Error("impor berkas tidak boleh dipakai");
      },
      importBare: async () => {
        bareDipanggil += 1;
        return modulPalsu();
      },
    });

    expect(load()).rejects.toBeInstanceOf(SdkNotInstalledError);
    await expect(load()).rejects.toThrow(SDK_NOT_INSTALLED_MESSAGE);
    expect(bareDipanggil).toBe(0);
  } finally {
    await home.selesai();
  }
});

test("bare yang tidak ditemukan menjadi SdkNotInstalledError", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });

    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importBare: async () => {
        const error = new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'");
        (error as Error & { code?: string }).code = "ERR_MODULE_NOT_FOUND";
        throw error;
      },
    });

    expect(load()).rejects.toBeInstanceOf(SdkNotInstalledError);
  } finally {
    await home.selesai();
  }
});

test("galat lain dari impor bare dilempar apa adanya", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });

    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importBare: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });

    expect(load()).rejects.toBeInstanceOf(SyntaxError);
  } finally {
    await home.selesai();
  }
});

test("SDK terkelola rusak dibungkus galat Indonesia dan tidak jatuh ke bare", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });
    await buatTerkelola(root, VERSI);

    let bareDipanggil = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importFile: async () => {
        throw new Error("berkas rusak");
      },
      importBare: async () => {
        bareDipanggil += 1;
        return modulPalsu();
      },
    });

    const galat = await load().catch((error: unknown) => error);
    expect(galat).toBeInstanceOf(SdkBrokenInstallError);
    const pesan = (galat as Error).message;
    expect(pesan).toContain(VERSI);
    expect(pesan).toContain("Pasang ulang");
    expect(bareDipanggil).toBe(0);
  } finally {
    await home.selesai();
  }
});

test("dua pemanggilan memakai satu impor (cache per jalur entri)", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });
    await buatTerkelola(root, VERSI);

    let jumlahImpor = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importFile: async () => {
        jumlahImpor += 1;
        return modulPalsu();
      },
    });

    await load();
    await load();
    expect(jumlahImpor).toBe(1);
  } finally {
    await home.selesai();
  }
});

test("versi baru memakai impor baru", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });
    await buatTerkelola(root, VERSI);

    const urlDipakai: string[] = [];
    const load = createSdkLoader({
      root,
      isCompiled: () => false,
      importFile: async (url) => {
        urlDipakai.push(url);
        return modulPalsu();
      },
    });

    await load();
    await buatTerkelola(root, VERSI_LAIN);
    await load();

    expect(urlDipakai).toHaveLength(2);
    expect(urlDipakai[0]).toContain(`v=${VERSI}`);
    expect(urlDipakai[1]).toContain(`v=${VERSI_LAIN}`);
  } finally {
    await home.selesai();
  }
});

test("symlink keluar dari akar dianggap SDK tidak terpasang", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    const luar = join(home.path, "luar.mjs");
    await mkdir(join(root, VERSI, "package"), { recursive: true });
    await writeFile(luar, "export function query() {}\n");
    await symlink(luar, join(root, VERSI, "package", "sdk.mjs"));
    await writeFile(
      join(root, "active.json"),
      `${JSON.stringify({
        version: VERSI,
        installedAt: "2026-01-01T00:00:00.000Z",
        integrity: "sha512-dummy",
      })}\n`,
    );

    let bareDipanggil = 0;
    const load = createSdkLoader({
      root,
      isCompiled: () => true,
      importFile: async () => {
        throw new Error("impor berkas tidak boleh dipakai");
      },
      importBare: async () => {
        bareDipanggil += 1;
        return modulPalsu();
      },
    });

    expect(load()).rejects.toBeInstanceOf(SdkNotInstalledError);
    expect(bareDipanggil).toBe(0);
  } finally {
    await home.selesai();
  }
});

test("impor nyata lewat file URL dari direktori sementara berhasil", async () => {
  const home = await akarSementara();
  try {
    const root = join(home.path, "sdk");
    await mkdir(root, { recursive: true });
    await buatTerkelola(
      root,
      VERSI,
      "export function query() { return (async function*() { yield { type: 'result' }; })(); }\n",
    );

    const load = createSdkLoader({ root, isCompiled: () => true });
    const sdk = await load();
    expect(typeof sdk.query).toBe("function");
    const hasil: unknown[] = [];
    for await (const item of sdk.query({ prompt: "halo" })) hasil.push(item);
    expect(hasil).toEqual([{ type: "result" }]);
  } finally {
    await home.selesai();
  }
});

test("deteksi binary tidak salah pada mode dev", () => {
  expect(detectCompiled()).toBe(false);
});

async function kumpulkan(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("runner menampilkan pesan belum terpasang dan pesan SDK terkelola rusak", async () => {
  const input: RunInput = {
    prompt: "halo",
    cwd: "/tmp/kerja",
    provider: PROVIDER,
  };

  const belum = await kumpulkan(
    createSdkRunner({
      load: async () => {
        throw new SdkNotInstalledError();
      },
    }).run(input),
  );
  expect(belum[0]).toEqual({ type: "error", message: SDK_NOT_INSTALLED_MESSAGE });
  expect(belum[1]).toEqual({
    type: "result",
    ok: false,
    error: SDK_NOT_INSTALLED_MESSAGE,
  });

  const rusak = await kumpulkan(
    createSdkRunner({
      load: async () => {
        throw new SdkBrokenInstallError("SDK terkelola versi 0.1.0 gagal dimuat.", "0.1.0");
      },
    }).run(input),
  );
  expect(rusak[0]).toEqual({
    type: "error",
    message: "SDK terkelola versi 0.1.0 gagal dimuat.",
  });
});
