import { describe, expect, test } from "bun:test";
import * as tsNs from "typescript";
import { htmlToJsx } from "../src/server/design/jsx";

// Impor default "typescript" tak jalan di Bun; ambil modulnya lewat default bila ada.
const ts = (tsNs as any).default ?? tsNs;

describe("htmlToJsx: atribut", () => {
  test("class, for, tabindex dan atribut umum dipetakan ke nama JSX", () => {
    const hasil = htmlToJsx(
      '<label for="nama" class="x" tabindex="2" readonly maxlength="10">Nama</label>',
    );
    expect(hasil.jsx).toBe(
      '<label htmlFor="nama" className="x" tabIndex="2" readOnly maxLength="10">Nama</label>',
    );
    expect(hasil.warnings).toEqual([]);
  });

  test("data-* dan aria-* dibiarkan, atribut tanpa nilai jadi boolean", () => {
    const hasil = htmlToJsx(
      '<div data-id="1" aria-label="Tutup" data-foo-bar="x"><input disabled required></div>',
    );
    expect(hasil.jsx).toBe(
      '<div data-id="1" aria-label="Tutup" data-foo-bar="x">\n  <input disabled required />\n</div>',
    );
  });

  test("checked jadi defaultChecked, value input/select jadi defaultValue, selected tetap", () => {
    const hasil = htmlToJsx(
      '<div><input type="checkbox" checked><select value="a"><option value="a" selected>A</option></select></div>',
    );
    expect(hasil.jsx).toBe(
      '<div>\n  <input type="checkbox" defaultChecked />\n  <select defaultValue="a">\n    <option value="a" selected>A</option>\n  </select>\n</div>',
    );
  });

  test("href #/rute tidak diubah", () => {
    expect(htmlToJsx('<a href="#/rute">Ke</a>').jsx).toBe('<a href="#/rute">Ke</a>');
  });
});

describe("htmlToJsx: style", () => {
  test("style jadi objek, custom property dan vendor prefix ditangani", () => {
    const hasil = htmlToJsx(
      '<div style="color: red; --brand: #00f; -webkit-line-clamp: 2; -ms-flex: 1; font-size: 12px">teks</div>',
    );
    expect(hasil.jsx).toBe(
      '<div style={{ color: "red", "--brand": "#00f", WebkitLineClamp: "2", msFlex: "1", fontSize: "12px" }}>teks</div>',
    );
  });
});

describe("htmlToJsx: elemen void", () => {
  test("void ditulis self-closing, elemen kosong biasa tetap berpasangan", () => {
    const hasil = htmlToJsx('<div><img src="a.png" alt="x"><br><hr><p></p></div>');
    expect(hasil.jsx).toBe(
      '<div>\n  <img src="a.png" alt="x" />\n  <br />\n  <hr />\n  <p></p>\n</div>',
    );
  });
});

describe("htmlToJsx: entitas dan kurung kurawal", () => {
  test("entitas bernama dan numerik diterjemahkan, < > jadi ekspresi", () => {
    const hasil = htmlToJsx(
      "<p>a &amp; b &lt; c &nbsp; d &#169; e &#x41; &gt; f &quot; g &apos; h &middot; &mdash; &ndash; &hellip; &rarr; &larr; &copy;</p>",
    );
    expect(hasil.jsx).toBe(
      '<p>a & b {"<"} c   d © e A {">"} f " g \' h · — – … → ← ©</p>',
    );
  });

  test("kurung kurawal di teks menjadi ekspresi string", () => {
    expect(htmlToJsx("<p>{kurung} {lain}</p>").jsx).toBe(
      '<p>{"{"}kurung{"}"} {"{"}lain{"}"}</p>',
    );
  });

  test("atribut dengan entitas &amp; diloloskan lagi", () => {
    expect(htmlToJsx('<div title="a &amp; b">x</div>').jsx).toBe(
      '<div title="a &amp; b">x</div>',
    );
  });
});

describe("htmlToJsx: svg", () => {
  test("atribut svg jadi camelCase, xlink:href jadi href, xmlns:xlink dibuang", () => {
    const hasil = htmlToJsx(
      '<svg viewBox="0 0 10 10" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#ikon" stroke-width="2"></use></svg>',
    );
    expect(hasil.jsx).toBe(
      '<svg viewBox="0 0 10 10">\n  <use href="#ikon" strokeWidth="2" />\n</svg>',
    );
  });

  test("title di dalam svg dipertahankan dengan atributnya", () => {
    const hasil = htmlToJsx(
      '<svg><title id="t">Judul</title><rect width="10" height="10" fill="red"/></svg>',
    );
    expect(hasil.jsx).toContain('<title id="t">Judul</title>');
    expect(hasil.jsx).toContain('<rect width="10" height="10" fill="red" />');
  });

  test("style di dalam svg dipindah ke css, elemen svg kosong self-closing", () => {
    const hasil = htmlToJsx('<svg><style>.s{fill:red}</style><g></g></svg>');
    expect(hasil.css).toBe(".s{fill:red}");
    expect(hasil.jsx).toBe("<svg>\n  <g />\n</svg>");
  });
});

describe("htmlToJsx: textarea dan pre", () => {
  test("textarea menjadi defaultValue string literal", () => {
    expect(htmlToJsx('<textarea name="x">baris1\nbaris2</textarea>').jsx).toBe(
      '<textarea name="x" defaultValue={"baris1\\nbaris2"} />',
    );
  });

  test("pre menjaga baris baru lewat string literal", () => {
    expect(htmlToJsx("<pre>baris1\nbaris2</pre>").jsx).toBe('<pre>{"baris1\\nbaris2"}</pre>');
  });
});

describe("htmlToJsx: perbaikan dan pembuangan", () => {
  test("tag yatim tidak melempar dan diberi peringatan", () => {
    const hasil = htmlToJsx("<p>teks</div><div><b>halo");
    expect(hasil.warnings).toContain("Struktur HTML diperbaiki.");
    expect(hasil.jsx).toContain("<b>halo</b>");
  });

  test("atribut onclick dibuang dengan peringatan", () => {
    const hasil = htmlToJsx('<button onclick="go()">Klik</button>');
    expect(hasil.jsx).toBe("<button>Klik</button>");
    expect(hasil.warnings).toContain('Atribut kejadian "onclick" dibuang.');
  });

  test("script dibuang dengan peringatan", () => {
    const hasil = htmlToJsx("<script>alert(1)</script><p>a</p>");
    expect(hasil.jsx).toBe("<p>a</p>");
    expect(hasil.warnings).toContain("Skrip dibuang.");
  });

  test("komentar dan link rel=stylesheet dibuang", () => {
    const hasil = htmlToJsx('<!-- komentar --><link rel="stylesheet" href="x.css"><p>a</p>');
    expect(hasil.jsx).toBe("<p>a</p>");
  });
});

describe("htmlToJsx: akar dan css", () => {
  test("beberapa anak akar dibungkus fragment", () => {
    expect(htmlToJsx("<p>a</p><p>b</p>").jsx).toBe("<>\n  <p>a</p>\n  <p>b</p>\n</>");
  });

  test("dokumen lengkap: warnings kosong dan title diambil", () => {
    const hasil = htmlToJsx(
      '<!doctype html><html><head><title>X</title></head><body><input type="text"><p>a</p></body></html>',
    );
    expect(hasil.warnings).toEqual([]);
    expect(hasil.title).toBe("X");
    expect(hasil.jsx).toBe("<>\n  <input type=\"text\" />\n  <p>a</p>\n</>");
  });

  test("semua style digabung berurutan dipisah baris kosong", () => {
    expect(htmlToJsx("<style>a{}</style><p>x</p><style>b{}</style>").css).toBe("a{}\n\nb{}");
  });

  test("determinisme: dua pemanggilan sama persis", () => {
    const html = '<html><body><div class="a"><p>Halo &amp; {x}</p><img src="a.png"></div></body></html>';
    const pertama = htmlToJsx(html);
    const kedua = htmlToJsx(html);
    expect(kedua).toEqual(pertama);
  });
});

describe("htmlToJsx: keluaran bisa dikompilasi", () => {
  test("JSX dari HTML kaya lolos transpileModule tanpa diagnostik", () => {
    const html = `<!doctype html><html><head><title>Kaya</title><style>.a{background:url(../assets/a.png)}</style></head>
<body>
  <form action="#" method="post" novalidate>
    <label for="nama">Nama &amp; gelar</label>
    <input id="nama" name="nama" type="text" value="Budi" required maxlength="40" autocomplete="name" readonly>
    <input type="checkbox" checked disabled>
    <select name="kota"><option value="a" selected>A</option></select>
    <textarea name="pesan">halo
dunia</textarea>
    <button type="submit" onclick="x()">Kirim &rarr;</button>
  </form>
  <table><thead><tr><th colspan="2">A</th></tr></thead><tbody><tr><td rowspan="2">1</td><td>2</td></tr></tbody></table>
  <svg viewBox="0 0 10 10" xmlns:xlink="http://www.w3.org/1999/xlink"><title id="t">Ikon</title><use xlink:href="#x" stroke-width="2"></use><circle cx="5" cy="5" r="4" fill-rule="evenodd"/></svg>
  <div style="color:red; --x: 1; -webkit-line-clamp: 2"><pre>baris1
baris2</pre><p>{kurung} &lt;tag&gt; &copy;</p></div>
</body></html>`;

    const { jsx } = htmlToJsx(html);
    const sumber = `export default function P() { return (\n${jsx}\n); }\n`;
    const keluaran = ts.transpileModule(sumber, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        reportDiagnostics: true,
      },
    });
    expect(keluaran.diagnostics ?? []).toHaveLength(0);
  });
});
