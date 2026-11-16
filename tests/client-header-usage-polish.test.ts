import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentChild, VNode } from "preact";
import { Topbar } from "../src/client/components/SessionHeader";
import { secretBadge } from "../src/client/lib/secret-badge";

const root = join(import.meta.dir, "..");

/** CSS tanpa komentar; komentar bisa memuat contoh aturan yang menyesatkan. */
const css = readFileSync(join(root, "src/client/styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const header = readFileSync(join(root, "src/client/components/SessionHeader.tsx"), "utf8");
const sidebar = readFileSync(join(root, "src/client/components/Sidebar.tsx"), "utf8");
const replyBar = readFileSync(join(root, "src/client/components/ReplyBar.tsx"), "utf8");
const dropdown = readFileSync(join(root, "src/client/components/Dropdown.tsx"), "utf8");
const usagePage = readFileSync(join(root, "src/client/components/UsagePage.tsx"), "utf8");

/* ---------- Bantuan ---------- */

/** Isi aturan sederhana (selektor persis) di dalam potongan CSS. */
function isiAturan(potongan: string, selektor: string): string | undefined {
  const pola = /([^{}]+)\{([^{}]*)\}/g;
  let cocok = pola.exec(potongan);
  while (cocok !== null) {
    const sel = cocok[1]?.trim() ?? "";
    if (sel.split(",").some((bagian) => bagian.trim() === selektor)) return cocok[2] ?? "";
    cocok = pola.exec(potongan);
  }
  return undefined;
}

/** Telusuri pohon VNode tanpa DOM (komponen tanpa hooks boleh dipanggil). */
function cariVNode(
  node: ComponentChild,
  syarat: (vnode: VNode) => boolean,
): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => cariVNode(child, syarat));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return cariVNode(rendered, syarat);
  }
  const diri = syarat(vnode) ? [vnode] : [];
  return diri.concat(cariVNode(vnode.props.children as ComponentChild, syarat));
}

function propVNode(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function teksVNode(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(teksVNode).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "string") return teksVNode(vnode.props.children as ComponentChild);
  return "";
}

const LENCANA = [
  ".jk-worktree-badge",
  ".jk-secret-badge",
  ".jk-budget-badge",
  ".jk-sandbox-badge",
];

/* ---------- A. Header sesi ---------- */

describe("header sesi", () => {
  test("lencana rahasia hanya ikon tapi aria-label menyebut keadaan utuh", () => {
    const badge = secretBadge({ redactedEvents: 2 });
    expect(badge?.label).toBe("Disamarkan");
    expect(badge?.ariaLabel).toBe("Rahasia disamarkan");

    const vnode = Topbar({
      onMenu: () => undefined,
      secretBadge: {
        label: badge?.label ?? "",
        title: badge?.title ?? "",
        ariaLabel: badge?.ariaLabel,
      },
    }) as VNode;
    const lencana = cariVNode(vnode, (n) => propVNode(n).class === "jk-secret-badge");
    expect(lencana).toHaveLength(1);
    expect(propVNode(lencana[0])["aria-label"]).toBe("Rahasia disamarkan");
    // Label jadi ikon saja; teks "Disamarkan" tidak lagi dirender di header.
    expect(teksVNode(lencana[0]?.props.children as ComponentChild)).not.toContain(
      "Disamarkan",
    );
  });

  test("empat lencana tak terpotong ellipsis di lebar desktop", () => {
    for (const kelas of LENCANA) {
      const isi = isiAturan(css, kelas);
      expect(isi, kelas).toBeDefined();
      expect(isi, kelas).toMatch(/flex:\s*none/);
      expect(isi, kelas).toMatch(/white-space:\s*nowrap/);
      expect(isi, kelas).toMatch(/overflow:\s*visible/);
      expect(isi, kelas).not.toMatch(/max-width/);
      expect(isi, kelas).not.toMatch(/text-overflow/);
    }
  });

  test("hanya judul sesi dan path yang boleh menyusut dengan ellipsis", () => {
    for (const selektor of [".jk-top-title h2", ".jk-top-title .jk-mono"]) {
      const isi = isiAturan(css, selektor);
      expect(isi, selektor).toBeDefined();
      expect(isi, selektor).toMatch(/min-width:\s*0/);
      expect(isi, selektor).toMatch(/overflow:\s*hidden/);
      expect(isi, selektor).toMatch(/text-overflow:\s*ellipsis/);
      expect(isi, selektor).toMatch(/white-space:\s*nowrap/);
    }
  });

  test("penanda Bypass di header menjelaskan izin yang dilewati", () => {
    const vnode = Topbar({ onMenu: () => undefined, bypass: true }) as VNode;
    const penanda = cariVNode(vnode, (n) => propVNode(n).class === "jk-bypass-marker");
    expect(penanda).toHaveLength(1);
    expect(propVNode(penanda[0])["title"]).toBe(
      "Izin dilewati: agen menjalankan tool tanpa bertanya",
    );
    expect(header).toContain('title="Izin dilewati: agen menjalankan tool tanpa bertanya"');
  });

  test("penanda Bypass di sidebar menjelaskan izin yang dilewati", () => {
    expect(sidebar).toContain('title="Izin dilewati: agen menjalankan tool tanpa bertanya"');
  });
});

/* ---------- B. Baris kontrol ---------- */

describe("baris kontrol", () => {
  test("pemicu dropdown punya chevron kecil yang menandakan bisa diklik", () => {
    expect(dropdown).toContain('class="jk-dd-chevron"');
    expect(dropdown).toContain('width="10"');
    expect(dropdown).toContain('height="10"');
    expect(dropdown).toContain('aria-hidden="true"');
    const isi = isiAturan(css, ".jk-dd-chevron");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/color:\s*var\(--t3\)/);
  });

  test("tiga pemicu di ReplyBar memakai chevron", () => {
    expect([...replyBar.matchAll(/^\s*chevron$/gm)]).toHaveLength(3);
  });

  test("cincin konteks menampilkan persen di sampingnya", () => {
    expect(replyBar).toContain("jk-ctx-pct");
    expect(replyBar).toContain("{context.percent}%");
    const isi = isiAturan(css, ".jk-ctx-pct");
    expect(isi).toBeDefined();
    expect(isi).toMatch(/font-size:\s*var\(--fs-micro\)/);
    expect(isi).toMatch(/color:\s*var\(--t3\)/);
  });
});

/* ---------- C. Usage ---------- */

describe("catatan usage", () => {
  test("catatan biaya menyebut model tanpa tarif dan sifat perkiraan SDK", () => {
    expect(usagePage).toContain("Biaya dihitung dari tarif model yang dikenal");
    expect(usagePage).toContain(
      "Model tanpa tarif (mis. DeepSeek, MiniMax) tidak dicatat di sini",
    );
    expect(usagePage).toContain("angka itu hanya perkiraan SDK.");
  });

  test("pesan kosong menyebut sesi tanpa tarif", () => {
    expect(usagePage).toContain(
      "Belum ada pemakaian yang tercatat dalam rentang ini. Sesi dengan model tanpa tarif tidak ikut dicatat.",
    );
  });
});
