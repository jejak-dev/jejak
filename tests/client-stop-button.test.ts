import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import type { SessionInfo, SessionStatus } from "../src/server/sessions/session-manager";
import { SessionHeader } from "../src/client/components/SessionHeader";
import { showsStopButton, StopButton } from "../src/client/components/ReplyBar";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function cariVNode(
  node: ComponentChild,
  syarat: (vnode: VNode) => boolean,
): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => cariVNode(child, syarat));
  const vnode = node as VNode;
  // Komponen tanpa hooks (Topbar) boleh dirender langsung agar(children) terlihat.
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

function sesi(status: SessionStatus): SessionInfo {
  return {
    id: "s_1",
    title: "Sesi uji",
    prompt: "",
    cwd: "/tmp/jejak",
    profileId: "p_1",
    permissionMode: "default",
    status,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    eventCount: 0,
    pendingPermissions: 0,
    queued: 0,
  };
}

/* ---------- Tes ---------- */

describe("showsStopButton", () => {
  test("hanya saat sesi berjalan", () => {
    expect(showsStopButton(sesi("berjalan"))).toBe(true);
    expect(showsStopButton(sesi("selesai"))).toBe(false);
    expect(showsStopButton(sesi("gagal"))).toBe(false);
    expect(showsStopButton(sesi("dibatalkan"))).toBe(false);
  });
});

describe("StopButton", () => {
  test("kotak berisi berlabel Hentikan", () => {
    const vnode = StopButton({ onInterrupt: () => undefined, interrupting: false }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    expect(tombol).toBeDefined();
    const prop = propVNode(tombol);
    expect(prop["aria-label"]).toBe("Hentikan");
    expect(prop["title"]).toBe("Hentikan");
    expect(prop["class"]).toBe("jk-stop");
    expect(prop["disabled"]).toBe(false);
  });

  test("memanggil onInterrupt saat diklik", () => {
    let dipanggil = 0;
    const vnode = StopButton({
      onInterrupt: () => {
        dipanggil += 1;
      },
      interrupting: false,
    }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    const onClick = propVNode(tombol)["onClick"] as () => void;
    onClick();
    expect(dipanggil).toBe(1);
  });

  test("mati saat sedang mengirim permintaan henti", () => {
    const vnode = StopButton({ onInterrupt: () => undefined, interrupting: true }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    expect(propVNode(tombol)["disabled"]).toBe(true);
  });
});

describe("SessionHeader", () => {
  test("tidak lagi memuat tombol Hentikan saat sesi berjalan", () => {
    const vnode = SessionHeader({
      session: sesi("berjalan"),
      status: "berjalan",
      onMenu: () => undefined,
      panelOpen: false,
      onTogglePanel: () => undefined,
    }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button");
    const label = tombol.map((n) => propVNode(n)["aria-label"]);
    const teks = tombol.map((n) => teksVNode(n.props.children as ComponentChild));
    expect(label).not.toContain("Hentikan");
    expect(teks).not.toContain("Hentikan");
    expect(tombol.map((n) => propVNode(n)["class"])).not.toContain("jk-pill-btn");
  });

  test("pesan galat henti tetap tampil di header", () => {
    const vnode = SessionHeader({
      session: sesi("berjalan"),
      status: "berjalan",
      onMenu: () => undefined,
      panelOpen: false,
      onTogglePanel: () => undefined,
      error: "Gagal menghentikan sesi.",
    }) as VNode;
    const galat = cariVNode(vnode, (n) => propVNode(n)["role"] === "alert");
    expect(galat).toHaveLength(1);
    expect(teksVNode(galat[0]?.props.children as ComponentChild)).toBe(
      "Gagal menghentikan sesi.",
    );
  });
});
