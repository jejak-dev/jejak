import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_END,
  AUTO_START,
  DesignDocError,
  syncDesignDoc,
} from "../src/server/design/design-doc";
import { initDesign } from "../src/server/design/write";

let dir: string;
let luar: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-doc-"));
  luar = await mkdtemp(join(tmpdir(), "jejak-design-doc-luar-"));
  await initDesign(dir, { tracked: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(luar, { recursive: true, force: true });
});

function docPath(): string {
  return join(dir, "design", "DESIGN.md");
}

async function isiDoc(): Promise<string> {
  return readFile(docPath(), "utf8");
}

function statusOf(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => 0,
    (error: unknown) => {
      expect(error).toBeInstanceOf(DesignDocError);
      return (error as DesignDocError).status;
    },
  );
}

describe("blok otomatis DESIGN.md", () => {
  test("blok baru ditambahkan ke DESIGN.md bawaan", async () => {
    const hasil = await syncDesignDoc(dir);
    expect(hasil.changed).toBe(true);

    const isi = await isiDoc();
    expect(isi).toContain(AUTO_START);
    expect(isi).toContain(AUTO_END);
    expect(isi).toContain("## Token saat ini");
    expect(isi).toContain("| Nama | Nilai |");
    expect(isi).toContain("| `--warna-latar` | `#f7f7f8` |");
    expect(isi).toContain("## Halaman saat ini");
    expect(isi).toContain("| Slug | Judul | Perangkat |");
    expect(isi).toContain("| `contoh` | Contoh | desktop |");
    // Teks bawaan perancah tetap ada.
    expect(isi).toContain("# Aturan Desain");
  });

  test("penggantian di antara penanda; panggilan kedua tak mengubah berkas", async () => {
    await syncDesignDoc(dir);
    const pertama = await isiDoc();

    // Pengguna mengubah teks di luar penanda.
    const diubah = `${pertama}\nCatatan pengguna.\n`;
    await writeFile(docPath(), diubah, "utf8");

    const kedua = await syncDesignDoc(dir);
    expect(kedua.changed).toBe(false);
    const isi = await isiDoc();
    expect(isi).toBe(diubah);
    expect(isi).toContain("Catatan pengguna.");
  });

  test("isi di antara penanda diganti, teks luar penanda utuh", async () => {
    await syncDesignDoc(dir);
    const sebelum = await isiDoc();
    const luarPenanda = sebelum.slice(0, sebelum.indexOf(AUTO_START));
    expect(luarPenanda).toContain("# Aturan Desain");

    // Nilai token berubah -> isi blok harus ikut berubah.
    await writeFile(
      join(dir, "design", "tokens.css"),
      ":root {\n  --warna-aksen: #123456;\n}\n",
      "utf8",
    );
    const hasil = await syncDesignDoc(dir);
    expect(hasil.changed).toBe(true);

    const isi = await isiDoc();
    expect(isi).toContain("| `--warna-aksen` | `#123456` |");
    expect(isi).not.toContain("`#2f6fed`");
    expect(isi.slice(0, isi.indexOf(AUTO_START))).toBe(luarPenanda);
  });

  test("berkas hilang dibuat dan hanya berisi blok", async () => {
    await rm(docPath(), { force: true });
    const hasil = await syncDesignDoc(dir);
    expect(hasil.changed).toBe(true);

    const isi = await isiDoc();
    expect(isi.startsWith(AUTO_START)).toBe(true);
    expect(isi.endsWith(`${AUTO_END}\n`)).toBe(true);
    expect(isi).toContain("| `--warna-latar` | `#f7f7f8` |");
  });

  test("folder design belum ada: galat 404", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-doc-kosong-"));
    try {
      let galat: unknown;
      try {
        await syncDesignDoc(kosong);
      } catch (error) {
        galat = error;
      }
      expect(galat).toBeInstanceOf(DesignDocError);
      expect((galat as DesignDocError).status).toBe(404);
      expect((galat as DesignDocError).message).toBe("Desain belum dibuat.");
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });

  test("tanda pipa pada nilai token di-escape", async () => {
    await writeFile(
      join(dir, "design", "tokens.css"),
      ':root {\n  --font: a|b;\n  --jarak: 16px;\n}\n',
      "utf8",
    );
    await syncDesignDoc(dir);
    const isi = await isiDoc();
    expect(isi).toContain("| `--font` | `a\\|b` |");
  });

  test("daftar kosong: catatan singkat, bukan tabel kosong", async () => {
    await rm(join(dir, "design", "tokens.css"), { force: true });
    await rm(join(dir, "design", "pages", "contoh.html"), { force: true });
    await writeFile(
      join(dir, "design", "design.json"),
      `${JSON.stringify({ version: 1, pages: [] }, null, 2)}\n`,
      "utf8",
    );

    await syncDesignDoc(dir);
    const isi = await isiDoc();
    expect(isi).toContain("Belum ada token.");
    expect(isi).toContain("Belum ada halaman.");
    expect(isi).not.toContain("| Nama | Nilai |");
  });

  test("DESIGN.md berupa symlink: galat 400", async () => {
    await rm(docPath(), { force: true });
    await writeFile(join(luar, "DESIGN.md"), "# luar\n", "utf8");
    await symlink(join(luar, "DESIGN.md"), docPath());

    expect(await statusOf(syncDesignDoc(dir))).toBe(400);
    // Isi berkas luar tak tersentuh.
    expect(await readFile(join(luar, "DESIGN.md"), "utf8")).toBe("# luar\n");
  });

  test("DESIGN.md terlalu besar: galat 413", async () => {
    await writeFile(docPath(), "x".repeat(256 * 1024 + 10), "utf8");
    expect(await statusOf(syncDesignDoc(dir))).toBe(413);
  });

  test("penulisan atomik: tak ada berkas sementara dan mode lama utuh", async () => {
    await chmod(docPath(), 0o600);
    await syncDesignDoc(dir);

    const isiFolder = await readdir(join(dir, "design"));
    expect(
      isiFolder.filter((name) => name.startsWith(".jejak-design-doc-") && name.endsWith(".tmp")),
    ).toEqual([]);

    const info = await Bun.file(docPath()).stat();
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("folder design tanpa DESIGN.md tapi dengan subfolder tetap aman", async () => {
    await rm(docPath(), { force: true });
    await mkdir(join(dir, "design", "assets"), { recursive: true });
    const hasil = await syncDesignDoc(dir);
    expect(hasil.changed).toBe(true);
    expect(await isiDoc()).toContain(AUTO_START);
  });
});
