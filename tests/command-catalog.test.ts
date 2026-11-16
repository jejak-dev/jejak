import { describe, expect, test } from "bun:test";
import type {
  AgentRunner,
  CommandInfo,
  ListCommandsInput,
} from "../src/server/agent/events";
import {
  CommandCatalog,
  filterCommands,
} from "../src/server/sessions/command-catalog";

/** Runner tiruan: daftar perintah disuntik, jumlah panggilan dihitung. */
function runnerTiruan(
  daftar: CommandInfo[] | (() => Promise<CommandInfo[]>),
): {
  runner: AgentRunner;
  panggilan: { jumlah: number };
  masukan: ListCommandsInput[];
} {
  const panggilan = { jumlah: 0 };
  const masukan: ListCommandsInput[] = [];
  const runner: AgentRunner = {
    async *run() {
      // tak dipakai pada tes katalog
    },
    async listCommands(input) {
      panggilan.jumlah += 1;
      masukan.push(input);
      return typeof daftar === "function" ? await daftar() : daftar;
    },
  };
  return { runner, panggilan, masukan };
}

function perintah(nama: string): CommandInfo {
  return { name: nama, description: `Perintah ${nama}.`, argumentHint: "" };
}

describe("penyaringan perintah", () => {
  test("nama diawali garis bawah dibuang", () => {
    const hasil = filterCommands([perintah("_rahasia"), perintah("compact")]);
    expect(hasil.map((item) => item.name)).toEqual(["compact"]);
  });

  test("perintah dalam daftar tolak dibuang", () => {
    const hasil = filterCommands([
      perintah("clear"),
      perintah("model"),
      perintah("output-style"),
      perintah("workflow-launch-exec"),
      perintah("compact"),
    ]);
    expect(hasil.map((item) => item.name)).toEqual(["compact"]);
  });

  test("nama diawali huruf didahulukan lalu alfabetis", () => {
    const hasil = filterCommands([
      perintah("zeta"),
      perintah("alpha"),
      perintah("1numerik"),
      perintah(":ruang"),
    ]);
    expect(hasil.map((item) => item.name)).toEqual([
      "alpha",
      "zeta",
      "1numerik",
      ":ruang",
    ]);
  });

  test("nama kembar dibuang", () => {
    const hasil = filterCommands([perintah("compact"), perintah("compact")]);
    expect(hasil.map((item) => item.name)).toEqual(["compact"]);
  });
});

describe("katalog perintah", () => {
  test("daftar dari SDK dipakai dan disaring", async () => {
    const { runner } = runnerTiruan([
      perintah("_hal"),
      perintah("clear"),
      perintah("compact"),
      perintah("contoh-skill"),
    ]);
    const katalog = new CommandCatalog({ runner });

    const hasil = await katalog.get({ cwd: "/tmp/kerja" });

    expect(hasil.source).toBe("sdk");
    expect(hasil.commands.map((item) => item.name)).toEqual([
      "compact",
      "contoh-skill",
    ]);
  });

  test("hasil disimpan sebentar sehingga runner tak dipanggil ulang", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    const pertama = await katalog.get({ cwd: "/tmp/kerja" });
    const kedua = await katalog.get({ cwd: "/tmp/kerja" });

    expect(panggilan.jumlah).toBe(1);
    expect(kedua).toBe(pertama);
  });

  test("permintaan serentak ke kunci sama berbagi satu panggilan", async () => {
    let selesai: (() => void) | undefined;
    const tunggu = new Promise<void>((resolve) => {
      selesai = resolve;
    });
    const { runner, panggilan } = runnerTiruan(async () => {
      await tunggu;
      return [perintah("compact")];
    });
    const katalog = new CommandCatalog({ runner });

    const keduanya = Promise.all([
      katalog.get({ cwd: "/tmp/kerja" }),
      katalog.get({ cwd: "/tmp/kerja" }),
      katalog.get({ cwd: "/tmp/kerja" }),
    ]);
    selesai?.();
    const hasil = await keduanya;

    expect(panggilan.jumlah).toBe(1);
    for (const item of hasil) expect(item.source).toBe("sdk");
  });

  test("entri kedaluwarsa dibaca ulang", async () => {
    let jam = 1_000;
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner, now: () => jam, ttlMs: 500 });

    await katalog.get({ cwd: "/tmp/kerja" });
    jam += 499;
    await katalog.get({ cwd: "/tmp/kerja" });
    expect(panggilan.jumlah).toBe(1);

    jam += 2;
    await katalog.get({ cwd: "/tmp/kerja" });
    expect(panggilan.jumlah).toBe(2);
  });

  test("kunci berbeda untuk folder kerja berbeda", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    await katalog.get({ cwd: "/tmp/kerja" });
    await katalog.get({ cwd: "/tmp/lain" });
    expect(panggilan.jumlah).toBe(2);
  });

  test("kunci berbeda untuk sumber pengguna berbeda", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: false, hooksEnabled: true },
    });
    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true },
    });
    expect(panggilan.jumlah).toBe(2);
  });

  test("urutan skill tak memengaruhi kunci", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, skills: ["b", "a"] },
    });
    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, skills: ["a", "b"] },
    });
    expect(panggilan.jumlah).toBe(1);
  });

  test("kunci berbeda untuk plugin berbeda", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, plugins: ["/tmp/plugin/alpha"] },
    });
    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, plugins: ["/tmp/plugin/beta"] },
    });
    expect(panggilan.jumlah).toBe(2);
  });

  test("urutan plugin tak memengaruhi kunci", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner });

    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, plugins: ["/tmp/b", "/tmp/a"] },
    });
    await katalog.get({
      cwd: "/tmp/kerja",
      claude: { userSettings: true, hooksEnabled: true, plugins: ["/tmp/a", "/tmp/b"] },
    });
    expect(panggilan.jumlah).toBe(1);
  });

  test("entri tertua dipangkas bila melebihi batas", async () => {
    const { runner, panggilan } = runnerTiruan([perintah("compact")]);
    const katalog = new CommandCatalog({ runner, maxEntries: 2 });

    await katalog.get({ cwd: "/tmp/a" });
    await katalog.get({ cwd: "/tmp/b" });
    await katalog.get({ cwd: "/tmp/c" });
    expect(panggilan.jumlah).toBe(3);

    // Entri "/tmp/a" sudah dipangkas, jadi dibaca ulang.
    await katalog.get({ cwd: "/tmp/a" });
    expect(panggilan.jumlah).toBe(4);
  });

  test("runner tanpa daftar perintah memakai daftar bawaan", async () => {
    const runner: AgentRunner = {
      async *run() {
        // tak dipakai
      },
    };
    const katalog = new CommandCatalog({ runner });

    const hasil = await katalog.get({ cwd: "/tmp/kerja" });

    expect(hasil.source).toBe("bawaan");
    expect(hasil.commands.map((item) => item.name)).toEqual([
      "compact",
      "context",
      "usage",
      "init",
    ]);
  });

  test("galat memakai daftar bawaan dan tak lempar", async () => {
    const { runner } = runnerTiruan(async () => {
      throw new Error("SDK gagal");
    });
    const katalog = new CommandCatalog({ runner });

    const hasil = await katalog.get({ cwd: "/tmp/kerja" });

    expect(hasil.source).toBe("bawaan");
    expect(hasil.commands.length).toBeGreaterThan(0);
  });

  test("galat tak disimpan lebih dari 30 detik", async () => {
    let jam = 1_000;
    const { runner, panggilan } = runnerTiruan(async () => {
      throw new Error("SDK gagal");
    });
    const katalog = new CommandCatalog({ runner, now: () => jam, ttlMs: 300_000 });

    await katalog.get({ cwd: "/tmp/kerja" });
    jam += 29_000;
    await katalog.get({ cwd: "/tmp/kerja" });
    expect(panggilan.jumlah).toBe(1);

    jam += 2_000;
    await katalog.get({ cwd: "/tmp/kerja" });
    expect(panggilan.jumlah).toBe(2);
  });
});
