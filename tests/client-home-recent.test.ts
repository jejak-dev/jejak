import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentChild, VNode } from "preact";
import type { SessionInfo } from "../src/server/sessions/session-manager";
import { RecentSessions } from "../src/client/components/RecentSessions";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

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

/* ---------- Data bantu ---------- */

function sesi(nomor: number, lain: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: `s_${nomor}`,
    title: `Sesi ${nomor}`,
    prompt: "",
    cwd: `/tmp/jejak/proyek-${nomor}`,
    profileId: "p_1",
    permissionMode: "default",
    status: "selesai",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: `2026-11-0${nomor}T00:00:00.000Z`,
    eventCount: 0,
    pendingPermissions: 0,
    queued: 0,
    ...lain,
  };
}

/* ---------- Sumber berkas ---------- */

const root = join(import.meta.dir, "..");
const appSrc = readFileSync(join(root, "src", "client", "app.tsx"), "utf8");
const composerSrc = readFileSync(join(root, "src", "client", "components", "Composer.tsx"), "utf8");
const stylesSrc = readFileSync(join(root, "src", "client", "styles.css"), "utf8");

/* ---------- Tes ---------- */

describe("RecentSessions", () => {
  test("memuat tautan sesi berhash", () => {
    const vnode = RecentSessions({ sessions: [sesi(1)] }) as VNode;
    const tautan = cariVNode(vnode, (n) => n.type === "a");
    expect(tautan).toHaveLength(1);
    expect(propVNode(tautan[0])["href"]).toBe("#/s/s_1");
  });

  test("bawaan menampilkan empat sesi terbaru", () => {
    const sessions = [1, 2, 3, 4, 5, 6].map((nomor) => sesi(nomor));
    const vnode = RecentSessions({ sessions }) as VNode;
    const tautan = cariVNode(vnode, (n) => n.type === "a");
    expect(tautan).toHaveLength(4);
    // Terbaru lebih dulu: s_6 paling baru.
    expect(propVNode(tautan[0])["href"]).toBe("#/s/s_6");
  });

  test("limit menentukan jumlah sesi", () => {
    const sessions = [1, 2, 3].map((nomor) => sesi(nomor));
    const vnode = RecentSessions({ sessions, limit: 2 }) as VNode;
    expect(cariVNode(vnode, (n) => n.type === "a")).toHaveLength(2);
  });

  test("tidak merender apa pun untuk daftar kosong", () => {
    expect(RecentSessions({ sessions: [] })).toBeNull();
  });

  test("tidak merender sesi arsip", () => {
    const sessions = [sesi(1, { archivedAt: "2026-11-02T00:00:00.000Z" }), sesi(2)];
    const vnode = RecentSessions({ sessions }) as VNode;
    const tautan = cariVNode(vnode, (n) => n.type === "a");
    expect(tautan).toHaveLength(1);
    expect(propVNode(tautan[0])["href"]).toBe("#/s/s_2");
  });

  test("tajuk bagian berbahasa Indonesia", () => {
    const vnode = RecentSessions({ sessions: [sesi(1)] }) as VNode;
    const tajuk = cariVNode(vnode, (n) => n.type === "h3");
    expect(tajuk).toHaveLength(1);
    expect(teksVNode(tajuk[0]?.props.children as ComponentChild)).toBe("Lanjutkan sesi");
  });

  test("baris memuat judul, folder kerja, dan waktu relatif", () => {
    const vnode = RecentSessions({
      sessions: [sesi(1, { title: "Refactor beranda", cwd: "/tmp/jejak/jejak" })],
    }) as VNode;
    const baris = cariVNode(vnode, (n) => n.type === "a")[0];
    const teks = teksVNode(baris?.props.children as ComponentChild);
    expect(teks).toContain("Refactor beranda");
    expect(teks).toContain("jejak");
    const waktu = cariVNode(vnode, (n) => n.type === "time");
    expect(waktu).toHaveLength(1);
    expect(teksVNode(waktu[0]?.props.children as ComponentChild)).not.toBe("");
  });

  test("folder tidak lagi memakai kelas jk-mono", () => {
    const vnode = RecentSessions({ sessions: [sesi(1)] }) as VNode;
    const folder = cariVNode(vnode, (n) =>
      String(propVNode(n)["class"] ?? "").includes("jk-home-recent-folder"),
    );
    expect(folder).toHaveLength(1);
    expect(String(propVNode(folder[0])["class"])).not.toContain("jk-mono");
  });
});

describe("beranda dan komposer", () => {
  test("app.tsx memasang RecentSessions", () => {
    expect(appSrc).toContain("<RecentSessions");
  });

  test("komposer memakai label Indonesia untuk chip folder", () => {
    expect(composerSrc).toContain("Pilih folder");
    expect(composerSrc).toContain("Folder kerja");
    expect(composerSrc).not.toContain("Pilih…");
    expect(composerSrc).not.toContain("Working directory");
  });

  test("gaya beranda punya tajuk daftar sesi terakhir", () => {
    expect(stylesSrc).toContain(".jk-home-recent-title");
  });
});
