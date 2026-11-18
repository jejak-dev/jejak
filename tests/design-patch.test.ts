import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
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
import { MAX_PAGE_BYTES } from "../src/server/design/manifest";
import { DesignPatchError, patchPage } from "../src/server/design/patch";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-patch-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-patch-luar-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const DOC = `<!doctype html>
<HTML lang="id">
<HEAD>
  <!-- komentar atas -->
  <STYLE>
    p > b { color: red; }
  </STYLE>
  <script>
    if (a < b && c > d) { console.log("&amp;"); }
  </script>
</HEAD>
<BODY>
  <div id="kartu">
    <p data-testid="judul">Judul &amp; sub</p>
  </div>
  <div><p>satu</p></div>
  <div><p>dua</p></div>
  <img src="logo.png" alt="logo">
  <a href="#" id="tautan">tautan</a>
  <button id="tombol" type="button">Klik</button>
</BODY>
</HTML>
`;

async function writePage(slug: string, content: string): Promise<void> {
  await writeFile(join(dir, "design", "pages", `${slug}.html`), content, "utf8");
}

function pagePath(slug: string): string {
  return join(dir, "design", "pages", `${slug}.html`);
}

async function mtimeOf(slug: string): Promise<number> {
  return Math.round((await lstat(pagePath(slug))).mtimeMs);
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DesignPatchError);
  return (error as DesignPatchError).status;
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DesignPatchError);
  return (error as DesignPatchError).message;
}

async function noTempFiles(): Promise<void> {
  const names = await readdir(join(dir, "design", "pages"));
  expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("patchPage ops", () => {
  test("replace memakai HTML", async () => {
    await writePage("beranda", DOC);
    const result = await patchPage(dir, {
      slug: "beranda",
      selector: '[id="kartu"]',
      op: "replace",
      value: "<section>baru</section>",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    expect(text).toContain("<section>baru</section>");
    expect(text).not.toContain('<div id="kartu">');
    expect(result.op).toBe("replace");
    expect(result.selector).toBe('[id="kartu"]');
    expect(result.slug).toBe("beranda");
    expect(result.mtime).toBe(await mtimeOf("beranda"));
  });

  test("inner menyisipkan HTML di dalam elemen", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: '[data-testid="judul"]',
      op: "inner",
      value: "<b>tebal</b>",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    expect(text).toContain('<p data-testid="judul"><b>tebal</b></p>');
  });

  test("text meng-escape HTML", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: '[data-testid="judul"]',
      op: "text",
      value: "<b>tebal</b> & lain",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    expect(text).toContain(
      '<p data-testid="judul">&lt;b&gt;tebal&lt;/b&gt; &amp; lain</p>',
    );
  });

  test("attr menetapkan dan menghapus atribut (nilai kosong)", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "attr",
      attr: "aria-label",
      value: "Tombol kirim",
    });
    expect(await readFile(pagePath("beranda"), "utf8")).toContain(
      '<button id="tombol" type="button" aria-label="Tombol kirim">',
    );
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "attr",
      attr: "type",
      value: "",
    });
    expect(await readFile(pagePath("beranda"), "utf8")).toContain(
      '<button id="tombol" aria-label="Tombol kirim">',
    );
  });

  test("style tidak ditolak sebagai atribut", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "attr",
      attr: "style",
      value: "color: red",
    });
    expect(await readFile(pagePath("beranda"), "utf8")).toContain('style="color: red"');
  });

  test("remove menghapus elemen dan mengabaikan value", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: '[id="tautan"]',
      op: "remove",
      value: "diabaikan",
    });
    expect(await readFile(pagePath("beranda"), "utf8")).not.toContain('id="tautan"');
  });

  test("before dan after menyisipkan di luar elemen", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "before",
      value: "<hr>",
    });
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "after",
      value: "<span>akhir</span>",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    expect(text).toContain('<hr><button id="tombol" type="button">Klik</button><span>akhir</span>');
  });

  test("rantai :nth-of-type memilih satu elemen", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: "body > div:nth-of-type(2) > p:nth-of-type(1)",
      op: "text",
      value: "diganti",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    expect(text).toContain("<div><p>diganti</p></div>");
    expect(text).toContain("<div><p>dua</p></div>");
  });

  test("dokumen lain tetap byte-identik", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: '[data-testid="judul"]',
      op: "text",
      value: "baru",
    });
    const text = await readFile(pagePath("beranda"), "utf8");
    const expected = DOC.replace("Judul &amp; sub", "baru");
    expect(text).toBe(expected);
  });

  test("tidak menyisakan berkas .tmp", async () => {
    await writePage("beranda", DOC);
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "text",
      value: "x",
    });
    await noTempFiles();
  });

  test("mode berkas lama dipertahankan", async () => {
    await writePage("beranda", DOC);
    await chmod(pagePath("beranda"), 0o640);
    await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "text",
      value: "x",
    });
    expect((await lstat(pagePath("beranda"))).mode & 0o777).toBe(0o640);
  });
});

describe("patchPage pencocokan selector", () => {
  test("0 cocok -> 404", async () => {
    await writePage("beranda", DOC);
    expect(await statusOf(patchPage(dir, { slug: "beranda", selector: "#tidak-ada", op: "remove" }))).toBe(404);
    expect(await messageOf(patchPage(dir, { slug: "beranda", selector: "#tidak-ada", op: "remove" }))).toBe(
      "Selector tidak cocok dengan elemen mana pun.",
    );
  });

  test("lebih dari satu cocok -> 409 dengan jumlah", async () => {
    await writePage("beranda", DOC);
    const status = await statusOf(patchPage(dir, { slug: "beranda", selector: "p", op: "remove" }));
    expect(status).toBe(409);
    const message = await messageOf(patchPage(dir, { slug: "beranda", selector: "p", op: "remove" }));
    expect(message).toContain("3 elemen");
    expect(message).toContain("lebih spesifik");
  });

  test("selector tak sah -> 400", async () => {
    await writePage("beranda", DOC);
    expect(await statusOf(patchPage(dir, { slug: "beranda", selector: "[[", op: "remove" }))).toBe(400);
    expect(await statusOf(patchPage(dir, { slug: "beranda", selector: "div >", op: "remove" }))).toBe(400);
    expect(await statusOf(patchPage(dir, { slug: "beranda", selector: "   ", op: "remove" }))).toBe(400);
    expect(await statusOf(patchPage(dir, { slug: "beranda", selector: "x".repeat(501), op: "remove" }))).toBe(400);
  });
});

describe("patchPage baseMtime", () => {
  test("cocok lalu berubah", async () => {
    await writePage("beranda", DOC);
    const first = await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "text",
      value: "a",
      baseMtime: await mtimeOf("beranda"),
    });
    const second = await patchPage(dir, {
      slug: "beranda",
      selector: "#tombol",
      op: "text",
      value: "b",
      baseMtime: first.mtime,
    });
    expect(second.slug).toBe("beranda");
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "#tombol", op: "text", value: "c", baseMtime: first.mtime - 1 }),
    )).toBe(409);
    expect(await messageOf(
      patchPage(dir, { slug: "beranda", selector: "#tombol", op: "text", value: "c", baseMtime: first.mtime - 1 }),
    )).toBe("Halaman berubah sejak dibaca; ambil selector baru.");
  });
});

describe("patchPage validasi input", () => {
  test("slug tak sah, tak ada, symlink, dan di luar folder", async () => {
    await writePage("beranda", DOC);
    expect(await statusOf(patchPage(dir, { slug: "Bukan-Slug", selector: "#tombol", op: "remove" }))).toBe(400);
    expect(await statusOf(patchPage(dir, { slug: "../luar", selector: "#tombol", op: "remove" }))).toBe(400);
    expect(await statusOf(patchPage(dir, { slug: "hilang", selector: "#tombol", op: "remove" }))).toBe(404);

    await writeFile(join(outside, "target.html"), DOC, "utf8");
    await symlink(join(outside, "target.html"), pagePath("tautan"));
    expect(await statusOf(patchPage(dir, { slug: "tautan", selector: "#tombol", op: "remove" }))).toBe(404);

    await rm(join(dir, "design", "pages"), { recursive: true, force: true });
    await symlink(outside, join(dir, "design", "pages"));
    expect(await statusOf(patchPage(dir, { slug: "target", selector: "#tombol", op: "remove" }))).toBe(404);
  });

  test("op dan value divalidasi", async () => {
    await writePage("beranda", DOC);
    const bad = { slug: "beranda", selector: "#tombol", op: "hapus" } as never;
    expect(await statusOf(patchPage(dir, bad))).toBe(400);
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "#tombol", op: "text" }),
    )).toBe(400);
    // replace dengan string kosong sah: elemen dihapus.
    const result = await patchPage(dir, {
      slug: "beranda",
      selector: "#tautan",
      op: "replace",
      value: "",
    });
    expect(result.op).toBe("replace");
    expect(await readFile(pagePath("beranda"), "utf8")).not.toContain('id="tautan"');
  });

  test("value lebih dari 64 KB -> 413", async () => {
    await writePage("beranda", DOC);
    const big = "x".repeat(64 * 1024 + 1);
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "#tombol", op: "text", value: big }),
    )).toBe(413);
    expect(await messageOf(
      patchPage(dir, { slug: "beranda", selector: "#tombol", op: "text", value: big }),
    )).toBe("Isi terlalu besar.");
  });

  test("atribut berbahaya ditolak", async () => {
    await writePage("beranda", DOC);
    const reject = async (attr: string, value?: string) =>
      statusOf(patchPage(dir, { slug: "beranda", selector: "#tautan", op: "attr", attr, value }));

    expect(await reject("onclick", "alert(1)")).toBe(400);
    expect(await reject("ONLOAD")).toBe(400);
    expect(await reject("srcdoc", "<p>x</p>")).toBe(400);
    expect(await reject("HREF", "javascript:alert(1)")).toBe(400);
    expect(await reject("href", " JaVa\tScript:alert(1)")).toBe(400);
    expect(await reject("src", "data:text/html,<b>x</b>")).toBe(400);
    expect(await reject("1bad")).toBe(400);
    expect(await reject("a b")).toBe(400);
    expect(await reject("x".repeat(65))).toBe(400);
    expect(await readFile(pagePath("beranda"), "utf8")).toBe(DOC);
  });

  test("elemen void menolak inner dan text", async () => {
    await writePage("beranda", DOC);
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "img", op: "inner", value: "x" }),
    )).toBe(400);
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "img", op: "text", value: "x" }),
    )).toBe(400);
    expect(await readFile(pagePath("beranda"), "utf8")).toBe(DOC);
  });
});

describe("patchPage batas ukuran", () => {
  test("hasil melebihi 512 KB -> 413 dan berkas tidak ditulis", async () => {
    const filler = `<!-- ${"a".repeat(470 * 1024)} -->`;
    const page = `<!doctype html><html><body>${filler}<p id="isi">awal</p></body></html>`;
    await writePage("beranda", page);
    const value = "b".repeat(64 * 1024);
    expect(await statusOf(
      patchPage(dir, { slug: "beranda", selector: "#isi", op: "inner", value }),
    )).toBe(413);
    expect(await messageOf(
      patchPage(dir, { slug: "beranda", selector: "#isi", op: "inner", value }),
    )).toBe("Halaman melebihi 512 KB.");
    expect(await readFile(pagePath("beranda"), "utf8")).toBe(page);
    expect((await lstat(pagePath("beranda"))).size).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    await noTempFiles();
  });
});
