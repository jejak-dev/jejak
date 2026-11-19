import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { DesignError, assemblePage } from "./assemble";
import { htmlToJsx } from "./jsx";
import { MAX_PAGE_BYTES, readDesign, resolveDesignDir } from "./manifest";
import { ZipError, buildZip } from "./zip";

/** Batas isi folder design/ saat di-zip. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;
/** Kedalaman folder di dalam design/ yang masih ikut di-zip. */
const MAX_DEPTH = 6;
/** Batas ukuran berkas tokens.css yang disalin ke proyek React. */
const MAX_TOKENS_BYTES = 256 * 1024;

/** Meta CSP yang disisipkan rakitan frame; berkas ekspor tak memerlukannya. */
const CSP_META_RE = /<meta http-equiv="Content-Security-Policy"[^>]*>/;

/** Hasil ekspor satu halaman menjadi berkas HTML mandiri. */
export interface StandaloneExport {
  filename: string;
  html: string;
}

/** Hasil ekspor folder `design/` menjadi satu arsip ZIP. */
export interface DesignZipExport {
  filename: string;
  data: Uint8Array;
  /** Jumlah berkas yang ikut di dalam arsip. */
  files: number;
  /** Jumlah berkas yang dilewati (tersembunyi, symlink, terlalu besar). */
  skipped: number;
}

/** True bila `target` berada di dalam `dir`. */
function isInside(dir: string, target: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix);
}

/**
 * Merakit satu halaman menjadi berkas HTML yang berdiri sendiri: CSS dan aset
 * sudah di-inline, tanpa skrip runtime frame dan tanpa meta CSP ketat.
 */
export async function exportStandalonePage(
  root: string,
  slug: string,
): Promise<StandaloneExport> {
  const page = await assemblePage(root, slug, { runtime: false });
  // Hanya meta yang disisipkan rakitan yang dibuang (occurrences pertama).
  const html = page.html.replace(CSP_META_RE, "");
  return { filename: `${slug}.html`, html };
}

interface CollectedFile {
  name: string;
  data: Uint8Array;
}

/**
 * Mengumpulkan isi satu folder secara rekursif. Symlink, berkas non-biasa,
 * dan entri tersembunyi dilewati; berkas terlalu besar dilewati dan dihitung.
 * `boundary` adalah akar realpath yang menentukan batas keamanan, dan
 * `relPrefix` disisipkan di depan nama entri (mis. "public/assets/").
 */
async function collectFiles(
  baseDir: string,
  boundary: string,
  relPrefix = "",
): Promise<{ files: CollectedFile[]; skipped: number }> {
  const files: CollectedFile[] = [];
  let skipped = 0;
  let total = 0;

  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (files.length >= MAX_FILES) {
        skipped += 1;
        continue;
      }
      // Entri tersembunyi (dotfile) tak ikut diekspor.
      if (dirent.name.startsWith(".")) {
        skipped += 1;
        continue;
      }
      // Symlink tak pernah diikuti.
      if (dirent.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth + 1 < MAX_DEPTH) await walk(path, childRel, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        skipped += 1;
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        skipped += 1;
        continue;
      }
      // Pastikan berkas benar-benar berada di dalam batas keamanan.
      let real: string;
      try {
        real = await realpath(path);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isInside(boundary, real)) {
        skipped += 1;
        continue;
      }
      let info;
      try {
        info = await lstat(path);
      } catch {
        skipped += 1;
        continue;
      }
      if (!info.isFile()) {
        skipped += 1;
        continue;
      }
      if (info.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      if (total + info.size > MAX_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch {
        skipped += 1;
        continue;
      }
      total += data.length;
      const name = relPrefix === "" ? childRel : `${relPrefix}/${childRel}`;
      files.push({ name, data: new Uint8Array(data) });
    }
  };

  await walk(baseDir, "", 0);
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files, skipped };
}

/**
 * Mengekspor seluruh isi folder `design/` sebagai satu arsip ZIP. Urut entri
 * alfabet agar keluarannya deterministik. Tanpa folder `design/` hasilnya
 * galat 404.
 */
export async function exportDesignZip(root: string): Promise<DesignZipExport> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignError("Folder desain tidak ditemukan.", 404);
  }
  const { files, skipped } = await collectFiles(designDir, designDir);
  let data: Uint8Array;
  try {
    data = buildZip(files);
  } catch (error) {
    if (error instanceof ZipError) throw new DesignError(error.message, 400);
    throw error;
  }
  return { filename: "design.zip", data, files: files.length, skipped };
}

/** Membaca berkas opsional di folder design; `undefined` bila tak ada/tak sah. */
async function readOptionalFile(
  designDir: string,
  name: string,
  limit: number,
): Promise<string | undefined> {
  const path = join(designDir, name);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > limit) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Membaca sumber satu halaman dengan pemeriksaan jalur aman. */
async function readPageSource(designDir: string, slug: string): Promise<string> {
  const pagePath = join(designDir, "pages", `${slug}.html`);
  let info;
  try {
    info = await lstat(pagePath);
  } catch {
    throw new Error("hilang");
  }
  if (!info.isFile()) throw new Error("bukan berkas");
  if (info.size > MAX_PAGE_BYTES) throw new Error("terlalu besar");
  let real: string;
  try {
    real = await realpath(pagePath);
  } catch {
    throw new Error("hilang");
  }
  if (!isInside(designDir, real)) throw new Error("di luar");
  try {
    return await readFile(pagePath, "utf8");
  } catch {
    throw new Error("tidak terbaca");
  }
}

/** Nama komponen PascalCase dari slug; diawali "Halaman" bila berawalan angka. */
function componentName(slug: string): string {
  const parts = slug.split("-").filter((part) => part !== "");
  let name = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
  if (name === "") name = "Halaman";
  if (!/^[a-zA-Z]/.test(name)) name = `Halaman${name}`;
  return name;
}

/** Nama unik dengan akhiran angka bila tabrakan. */
function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Menormalkan satu rujukan aset relatif menjadi `/assets/...`. */
function normalizeAssetRef(value: string): string {
  if (/^(?:data:|https?:|\/\/|#|\/)/i.test(value)) return value;
  const cleaned = value.replace(/^(?:\.\/|\.\.\/)+/, "");
  if (cleaned.startsWith("assets/") || cleaned === "assets") return `/${cleaned}`;
  return value;
}

/** Mengganti rujukan aset pada atribut `src`/`href`/`srcSet` di JSX. */
function rewriteJsxAssets(jsx: string): string {
  return jsx.replace(
    /(\s)(src|srcSet|href)="([^"]*)"/g,
    (_whole, space: string, attr: string, value: string) => {
      if (attr === "srcSet") {
        const rewritten = value
          .split(",")
          .map((part) => normalizeAssetRef(part.trim()))
          .join(", ");
        return `${space}${attr}="${rewritten}"`;
      }
      return `${space}${attr}="${normalizeAssetRef(value)}"`;
    },
  );
}

/** Mengganti rujukan aset pada `url(...)` di CSS. */
function rewriteCssAssets(css: string): string {
  return css.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g,
    (whole, dq?: string, sq?: string, bare?: string) => {
      const raw = (dq ?? sq ?? bare ?? "").trim();
      if (raw === "" || /^(?:data:|https?:|\/\/|#|\/)/i.test(raw)) return whole;
      const cleaned = raw.replace(/^(?:\.\/|\.\.\/)+/, "");
      if (!(cleaned.startsWith("assets/") || cleaned === "assets")) return whole;
      return `url("/${cleaned}")`;
    },
  );
}

/** Menyisipkan awalan pada tiap baris. */
function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => prefix + line).join("\n");
}

/** Berkas dasar proyek Vite yang tetap. */
const PACKAGE_JSON = {
  name: "design-export",
  version: "0.0.0",
  private: true,
  type: "module",
  scripts: {
    dev: "vite",
    build: "tsc --noEmit && vite build",
    typecheck: "tsc --noEmit",
  },
  dependencies: {
    react: "^18.3.1",
    "react-dom": "^18.3.1",
  },
  devDependencies: {
    typescript: "^5.6.0",
    vite: "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
  },
};

const TSCONFIG_JSON = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    jsx: "react-jsx",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ["src"],
};

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`;

const VITE_ENV = `/// <reference types="vite/client" />
`;

const GITIGNORE = `node_modules
dist
`;

const MAIN_TSX = `import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";

createRoot(document.getElementById("root")!).render(<App />);
`;

const INDEX_HTML = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Design Export</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

interface ReactPage {
  slug: string;
  title: string;
  name: string;
}

/** Merender satu komponen halaman ke teks berkas `.tsx`. */
function renderPageComponent(name: string, jsx: string, css: string): string {
  const lines: string[] = [];
  if (css !== "") {
    lines.push(`import "./${name}.css";`);
    lines.push("");
  }
  lines.push(`export default function ${name}(): JSX.Element {`);
  lines.push("  return (");
  lines.push(indent(jsx, "    "));
  lines.push("  );");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Merender `src/App.tsx` dengan router hash minimal. */
function renderApp(pages: ReactPage[]): string {
  const imports = pages.map((page) => `import ${page.name} from "./pages/${page.name}";`).join("\n");
  const pageEntries = pages.map((page) => `  ${JSON.stringify(page.slug)}: ${page.name},`).join("\n");
  const titleEntries = pages
    .map((page) => `  ${JSON.stringify(page.slug)}: ${JSON.stringify(page.title)},`)
    .join("\n");
  const defaultSlug = pages[0]!.slug;
  return `import { useEffect, useState } from "react";
${imports}

const PAGES: Record<string, () => JSX.Element> = {
${pageEntries}
};

const TITLES: Record<string, string> = {
${titleEntries}
};

const DEFAULT = ${JSON.stringify(defaultSlug)};

function currentSlug(): string {
  const hash = window.location.hash;
  return hash.startsWith("#/") ? hash.slice(2) : hash.slice(1);
}

function App(): JSX.Element {
  const [slug, setSlug] = useState<string>(() => {
    const active = currentSlug();
    return active in PAGES ? active : DEFAULT;
  });

  useEffect(() => {
    const onHash = (): void => {
      const active = currentSlug();
      setSlug(active in PAGES ? active : DEFAULT);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.title = TITLES[slug] ?? DEFAULT;
  }, [slug]);

  const Page = PAGES[slug] ?? PAGES[DEFAULT]!;
  return <Page />;
}

export default App;
`;
}

/** Merender `README.md` dengan catatan konversi per halaman. */
function renderReadme(conversions: Array<{ name: string; slug: string; warnings: string[] }>): string {
  const lines: string[] = [];
  lines.push("# Design Export");
  lines.push("");
  lines.push(
    "Proyek React (Vite + TypeScript) hasil ekspor desain dari Jejak. Setiap halaman dikonversi mekanis menjadi satu komponen React di `src/pages/`, tanpa pemecahan komponen lebih lanjut.",
  );
  lines.push("");
  lines.push("## Menjalankan");
  lines.push("");
  lines.push("```bash");
  lines.push("npm install");
  lines.push("npm run dev");
  lines.push("```");
  lines.push("");
  lines.push("Perintah lain:");
  lines.push("");
  lines.push("- `npm run build` membangun produksi ke `dist/`.");
  lines.push("- `npm run typecheck` memeriksa tipe TypeScript.");
  lines.push("");
  lines.push("## Struktur");
  lines.push("");
  lines.push("- `src/pages/<Nama>.tsx` satu komponen per halaman desain.");
  lines.push("- `src/styles/tokens.css` token desain global.");
  lines.push("- `public/assets/` aset gambar dan font desain.");
  lines.push("");
  lines.push("## Catatan");
  lines.push("");
  lines.push(
    "- CSS halaman tidak di-scope (global). Setiap halaman memuat berkas CSS sendiri bersama komponennya.",
  );
  lines.push("");
  lines.push("## Catatan konversi");
  lines.push("");
  const warned = conversions.filter((page) => page.warnings.length > 0);
  if (warned.length === 0) {
    lines.push("Tidak ada peringatan konversi.");
  } else {
    for (const page of warned) {
      lines.push(`- \`${page.name}\` (\`${page.slug}\`): ${page.warnings.join(" ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Mengekspor folder `design/` menjadi proyek React (Vite + TypeScript) yang
 * berdiri sendiri. Setiap halaman menjadi satu komponen di `src/pages/`.
 * Tanpa folder `design/` atau tanpa halaman hasilnya galat 404.
 */
export async function exportReactProject(root: string): Promise<DesignZipExport> {
  const designDir = await resolveDesignDir(root);
  if (designDir === undefined) {
    throw new DesignError("Folder desain tidak ditemukan.", 404);
  }
  const design = await readDesign(root);

  const pages: ReactPage[] = [];
  const conversions: Array<{
    name: string;
    slug: string;
    warnings: string[];
    jsx: string;
    css: string;
  }> = [];
  const usedNames = new Set<string>();
  let skipped = 0;

  for (const page of design.pages) {
    if (page.missing || page.tooLarge) {
      skipped += 1;
      continue;
    }
    let source: string;
    try {
      source = await readPageSource(designDir, page.slug);
    } catch {
      skipped += 1;
      continue;
    }
    const name = uniqueName(componentName(page.slug), usedNames);
    const converted = htmlToJsx(source);
    conversions.push({
      name,
      slug: page.slug,
      warnings: converted.warnings,
      jsx: rewriteJsxAssets(converted.jsx),
      css: rewriteCssAssets(converted.css),
    });
    pages.push({ slug: page.slug, title: page.title, name });
  }

  if (pages.length === 0) {
    throw new DesignError("Belum ada halaman untuk diekspor.", 404);
  }

  const entries: CollectedFile[] = [];
  entries.push({ name: "package.json", data: new TextEncoder().encode(`${JSON.stringify(PACKAGE_JSON, null, 2)}\n`) });
  entries.push({ name: "tsconfig.json", data: new TextEncoder().encode(`${JSON.stringify(TSCONFIG_JSON, null, 2)}\n`) });
  entries.push({ name: "vite.config.ts", data: new TextEncoder().encode(VITE_CONFIG) });
  entries.push({ name: "index.html", data: new TextEncoder().encode(INDEX_HTML) });
  entries.push({ name: ".gitignore", data: new TextEncoder().encode(GITIGNORE) });
  entries.push({ name: "README.md", data: new TextEncoder().encode(renderReadme(conversions)) });
  entries.push({ name: "src/main.tsx", data: new TextEncoder().encode(MAIN_TSX) });
  entries.push({ name: "src/vite-env.d.ts", data: new TextEncoder().encode(VITE_ENV) });
  entries.push({ name: "src/App.tsx", data: new TextEncoder().encode(renderApp(pages)) });

  const tokens = await readOptionalFile(designDir, "tokens.css", MAX_TOKENS_BYTES);
  if (tokens !== undefined) {
    entries.push({ name: "src/styles/tokens.css", data: new TextEncoder().encode(tokens) });
  }

  for (const conversion of conversions) {
    entries.push({
      name: `src/pages/${conversion.name}.tsx`,
      data: new TextEncoder().encode(renderPageComponent(conversion.name, conversion.jsx, conversion.css)),
    });
    if (conversion.css !== "") {
      entries.push({
        name: `src/pages/${conversion.name}.css`,
        data: new TextEncoder().encode(`${conversion.css}\n`),
      });
    }
  }

  const assetDir = join(designDir, "assets");
  const assets = await collectFiles(assetDir, designDir, "public/assets");
  skipped += assets.skipped;
  entries.push(...assets.files);

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let data: Uint8Array;
  try {
    data = buildZip(entries);
  } catch (error) {
    if (error instanceof ZipError) throw new DesignError(error.message, 400);
    throw error;
  }
  return { filename: "design-react.zip", data, files: entries.length, skipped };
}
