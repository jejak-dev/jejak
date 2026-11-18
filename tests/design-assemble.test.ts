import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesignError, assemblePage, buildCsp } from "../src/server/design/assemble";

let dir: string;
let outside: string;

const CSP_DASAR =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; " +
  "font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
const CSP_FONT =
  "default-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; img-src data:; " +
  "font-src data: https://fonts.gstatic.com; connect-src 'none'; form-action 'none'; " +
  "base-uri 'none'; frame-src 'none'";
const GIF_1X1 = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-assemble-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-luar-"));
  await mkdir(join(dir, "design", "pages"), { recursive: true });
  await mkdir(join(dir, "design", "assets"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function page(slug: string, html: string): Promise<void> {
  await writeFile(join(dir, "design", "pages", `${slug}.html`), html, "utf8");
}

async function file(rel: string, content: string | Buffer): Promise<void> {
  const path = join(dir, "design", rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

function cspOf(html: string): string | undefined {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  return match?.[1];
}

describe("buildCsp", () => {
  test("isi persis, dengan dan tanpa Google Fonts", () => {
    expect(buildCsp()).toBe(CSP_DASAR);
    expect(buildCsp(true)).toBe(CSP_FONT);
  });
});

describe("CSP di posisi pertama head", () => {
  test("dokumen dengan <head>", async () => {
    await page("a", "<!doctype html><html><head><title>x</title></head><body>x</body></html>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${CSP_DASAR}"><title>`);
    expect(cspOf(result.html)).toBe(CSP_DASAR);
  });

  test("dokumen tanpa <head> menyisipkan head setelah <html>", async () => {
    await page("a", "<!doctype html><html><body>x</body></html>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`<html><head><meta http-equiv="Content-Security-Policy"`);
    expect(result.html.indexOf("<head>")).toBeLessThan(result.html.indexOf("<body>"));
  });

  test("dokumen tanpa head dan tanpa html menyisipkan setelah doctype", async () => {
    await page("a", "<!doctype html><body>x</body>");
    const result = await assemblePage(dir, "a");
    expect(result.html.startsWith(`<!doctype html><head><meta http-equiv="Content-Security-Policy"`)).toBe(true);
  });

  test("huruf besar <HEAD> tetap dikenali", async () => {
    await page("a", "<HTML><HEAD><TITLE>x</TITLE></HEAD><BODY>x</BODY></HTML>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`<HEAD><meta http-equiv="Content-Security-Policy"`);
  });

  test("varian allowGoogleFonts", async () => {
    await page("a", "<html><head></head><body>x</body></html>");
    const result = await assemblePage(dir, "a", { allowGoogleFonts: true });
    expect(cspOf(result.html)).toBe(CSP_FONT);
  });
});

describe("tag berbahaya", () => {
  test("<base> dan <script src> dihapus, skrip inline tetap", async () => {
    await page(
      "a",
      '<html><head><base href="https://jahat.test/"></head><body>' +
        '<script src="https://jahat.test/x.js"></script>' +
        "<script>console.log(1)</script></body></html>",
    );
    const result = await assemblePage(dir, "a");
    expect(result.html).not.toContain("<base");
    expect(result.html).not.toContain("jahat.test/x.js");
    expect(result.html).toContain("<script>console.log(1)</script>");
    expect(result.warnings).toContain("Tag <base> dihapus.");
    expect(result.warnings).toContain("Skrip luar dihapus: https://jahat.test/x.js.");
  });
});

describe("inline CSS", () => {
  test("link rel=stylesheet relatif menjadi <style>", async () => {
    await file("tokens.css", ":root{--warna:#111}");
    await page("a", '<html><head><link rel="stylesheet" href="../tokens.css"></head><body>x</body></html>');
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain("<style>:root{--warna:#111}</style>");
    expect(result.html).not.toContain("<link");
    expect(result.warnings).toEqual([]);
  });

  test("kutip tunggal dan urutan atribut berbeda", async () => {
    await file("tokens.css", "body{color:red}");
    await page("a", "<html><head><link href='../tokens.css' rel='stylesheet'></head><body>x</body></html>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain("<style>body{color:red}</style>");
  });

  test("CSS tidak ada, keluar folder, absolut, symlink keluar, bukan .css, > 256 KB dihapus", async () => {
    await file("catatan.txt", "bukan css");
    await file("besar.css", "a".repeat(256 * 1024 + 1));
    await writeFile(join(outside, "rahasia.css"), "body{color:red}", "utf8");
    await symlink(join(outside, "rahasia.css"), join(dir, "design", "tautan.css"));
    await page(
      "a",
      "<html><head>" +
        '<link rel="stylesheet" href="../tidak-ada.css">' +
        '<link rel="stylesheet" href="../../rahasia.css">' +
        '<link rel="stylesheet" href="/etc/passwd.css">' +
        '<link rel="stylesheet" href="../tautan.css">' +
        '<link rel="stylesheet" href="../catatan.txt">' +
        '<link rel="stylesheet" href="../besar.css">' +
        "</head><body>x</body></html>",
    );
    const result = await assemblePage(dir, "a");
    expect(result.html).not.toContain("<link");
    expect(result.html).not.toContain("<style>");
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings.join("\n")).toContain("tidak-ada.css");
    expect(result.warnings.join("\n")).toContain("di luar folder design");
    expect(result.warnings.join("\n")).toContain("path absolut");
    expect(result.warnings.join("\n")).toContain("bukan berkas .css");
    expect(result.warnings.join("\n")).toContain("melebihi 256 KB");
  });

  test("@import dihapus dengan warning", async () => {
    await file("tokens.css", '@import url("https://fonts.test/x.css");\nbody{color:red}');
    await page("a", '<html><head><link rel="stylesheet" href="../tokens.css"></head><body>x</body></html>');
    const result = await assemblePage(dir, "a");
    expect(result.html).not.toContain("@import");
    expect(result.html).toContain("body{color:red}");
    expect(result.warnings).toContain("@import tidak didukung, dihapus.");
  });
});

describe("aset menjadi data URI", () => {
  test("url() relatif di CSS menjadi data URI png dan woff2", async () => {
    await file("assets/a.png", Buffer.from([1, 2, 3]));
    await file("assets/f.woff2", Buffer.from([4, 5]));
    await file("tokens.css", "a{background:url(assets/a.png)}@font-face{src:url('assets/f.woff2')}");
    await page("a", '<html><head><link rel="stylesheet" href="../tokens.css"></head><body>x</body></html>');
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`url("data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}")`);
    expect(result.html).toContain(`url("data:font/woff2;base64,${Buffer.from([4, 5]).toString("base64")}")`);
    expect(result.warnings).toEqual([]);
  });

  test("svg hanya sebagai gambar, ekstensi lain ditolak", async () => {
    await file("assets/i.svg", "<svg></svg>");
    await file("assets/x.html", "<b>x</b>");
    await file("assets/y.js", "x");
    await file("assets/z.exe", "x");
    await page(
      "a",
      "<html><body>" +
        '<img src="../assets/i.svg">' +
        '<img src="../assets/x.html">' +
        '<img src="../assets/y.js">' +
        '<img src="../assets/z.exe">' +
        "</body></html>",
    );
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`src="data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}"`);
    expect(result.html.match(new RegExp(GIF_1X1, "g"))).toHaveLength(3);
    expect(result.warnings.join("\n")).toContain("tipe berkas tidak diizinkan");
  });

  test("symlink aset keluar folder ditolak", async () => {
    await writeFile(join(outside, "luar.png"), Buffer.from([9]), "utf8");
    await symlink(join(outside, "luar.png"), join(dir, "design", "assets", "luar.png"));
    await page("a", '<html><body><img src="../assets/luar.png"></body></html>');
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`src="${GIF_1X1}"`);
    expect(result.warnings.join("\n")).toContain("di luar folder design");
  });

  test("img dan source gagal diganti gif 1x1", async () => {
    await page(
      "a",
      '<html><body><img src="../assets/hilang.png"><picture><source src="../assets/hilang.webp"></picture></body></html>',
    );
    const result = await assemblePage(dir, "a");
    expect(result.html.match(new RegExp(GIF_1X1, "g"))).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
  });

  test("batas 512 KB per aset", async () => {
    await file("assets/besar.png", Buffer.alloc(512 * 1024 + 1));
    await page("a", '<html><body><img src="../assets/besar.png"></body></html>');
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain(`src="${GIF_1X1}"`);
    expect(result.warnings.join("\n")).toContain("melebihi 512 KB");
  });

  test("batas total 4 MB: aset berikutnya diganti penampung", async () => {
    const names: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const name = `assets/a${i}.png`;
      names.push(name);
      await file(name, Buffer.alloc(500_000, i));
    }
    const imgs = names.map((name) => `<img src="../${name}">`).join("");
    await page("a", `<html><body>${imgs}</body></html>`);
    const result = await assemblePage(dir, "a");
    expect(result.html.match(new RegExp(GIF_1X1, "g"))).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("melebihi batas total 4 MB");
  });

  test("sumber http(s) dibiarkan dengan warning, Google Fonts tanpa warning bila diizinkan", async () => {
    await page(
      "a",
      "<html><head>" +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
        '<link rel="stylesheet" href="https://cdn.test/x.css">' +
        "</head><body>" +
        '<img src="https://cdn.test/a.png">' +
        '<div style="background:url(https://cdn.test/b.png)"></div>' +
        "</body></html>",
    );
    const blocked = await assemblePage(dir, "a");
    expect(blocked.html).toContain('href="https://fonts.googleapis.com/css2?family=Inter"');
    expect(blocked.html).toContain('src="https://cdn.test/a.png"');
    expect(blocked.warnings).toContain("Sumber luar diblokir di frame: https://fonts.googleapis.com/css2?family=Inter");
    expect(blocked.warnings).toContain("Sumber luar diblokir di frame: https://cdn.test/x.css");
    expect(blocked.warnings).toContain("Sumber luar diblokir di frame: https://cdn.test/a.png");
    expect(blocked.warnings).toContain("Sumber luar diblokir di frame: https://cdn.test/b.png");

    const allowed = await assemblePage(dir, "a", { allowGoogleFonts: true });
    expect(allowed.warnings).not.toContain(
      "Sumber luar diblokir di frame: https://fonts.googleapis.com/css2?family=Inter",
    );
    expect(allowed.warnings).toContain("Sumber luar diblokir di frame: https://cdn.test/x.css");
  });
});

describe("runtime dan galat", () => {
  test("runtime disisipkan sebelum </body> terakhir", async () => {
    await page("a", "<html><body><p>x</p></body></html>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain('<script data-jejak-design-runtime>');
    expect(result.html).toContain('"a"');
    expect(result.html).toContain("</script></body>");
  });

  test("runtime di akhir dokumen bila tak ada </body>", async () => {
    await page("a", "<html><p>x</p></html>");
    const result = await assemblePage(dir, "a");
    expect(result.html).toContain('<script data-jejak-design-runtime>');
    expect(result.html.endsWith("</script>")).toBe(true);
  });

  test("slug tak sah 400, halaman tak ada 404, melebihi 512 KB 413", async () => {
    await expect(assemblePage(dir, "../x")).rejects.toMatchObject({ status: 400 });
    await expect(assemblePage(dir, "Tidak-Valid")).rejects.toMatchObject({ status: 400 });
    await expect(assemblePage(dir, "hilang")).rejects.toMatchObject({ status: 404 });
    await page("besar", "a".repeat(512 * 1024 + 1));
    await expect(assemblePage(dir, "besar")).rejects.toMatchObject({ status: 413 });
    const error = await assemblePage(dir, "hilang").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesignError);
    expect((error as DesignError).message).toBe("Halaman tidak ditemukan.");
  });

  test("masukan patologis selesai cepat", async () => {
    await page("a", "<html><body>" + "<link ".repeat(80_000) + "</body></html>");
    const started = performance.now();
    const result = await assemblePage(dir, "a");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result.html).toContain("Content-Security-Policy");
  });
});

describe("celah penyisipan", () => {
  test("<head> palsu di dalam komentar tidak menelan CSP", async () => {
    await page("trik", "<!-- <head> --><html><body>x</body></html>");
    const { html } = await assemblePage(dir, "trik");
    const komentar = html.indexOf("<!--");
    const akhirKomentar = html.indexOf("-->");
    const csp = html.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(akhirKomentar);
    expect(komentar).toBeLessThan(akhirKomentar);
    expect(html).toContain("<html><head><meta");
  });

  test("url() di atribut style kutip ganda tidak memutus atribut", async () => {
    await file("a.png", Buffer.from([1, 2, 3]));
    await page("gaya", '<html><body><div style="background:url(../a.png)">x</div></body></html>');
    const { html } = await assemblePage(dir, "gaya");
    expect(html).toContain("style=\"background:url('data:image/png;base64,AQID')\"");
  });
});
