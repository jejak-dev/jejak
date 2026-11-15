import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ResumeBannerView } from "../src/client/components/Timeline";
import { InterruptedNote, PLAN_INTERRUPTED_NOTE } from "../src/client/components/PlanCard";
import { endedByRestart, SESSION_RESTART_MESSAGE } from "../src/client/lib/sessions";
import type { TimelineItem } from "../src/client/lib/timeline";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

/* ---------- Data uji ---------- */

const RESTART_ITEMS: TimelineItem[] = [
  { kind: "user", text: "kerjakan" },
  { kind: "error", message: SESSION_RESTART_MESSAGE },
  { kind: "result", ok: false, error: SESSION_RESTART_MESSAGE },
];

describe("endedByRestart", () => {
  test("true bila galat terakhir adalah restart server", () => {
    expect(endedByRestart(RESTART_ITEMS)).toBe(true);
  });

  test("false bila ada pesan pengguna sesudahnya", () => {
    expect(
      endedByRestart([...RESTART_ITEMS, { kind: "user", text: "lanjut" }]),
    ).toBe(false);
  });

  test("false bila galat terakhir berbeda", () => {
    expect(
      endedByRestart([
        ...RESTART_ITEMS,
        { kind: "error", message: "galat lain" },
      ]),
    ).toBe(false);
  });

  test("false bila tak ada galat sama sekali", () => {
    expect(endedByRestart([{ kind: "user", text: "halo" }])).toBe(false);
  });
});

describe("spanduk lanjutkan sesi", () => {
  test("tak tampil saat tak terlihat", () => {
    const banner = ResumeBannerView({
      visible: false,
      busy: false,
      onContinue: (): void => undefined,
    });
    expect(banner).toBeNull();
  });

  test("tampil dengan pesan dan tombol lanjutkan", () => {
    let dipanggil = 0;
    const banner = ResumeBannerView({
      visible: true,
      busy: false,
      onContinue: (): void => {
        dipanggil += 1;
      },
    });
    const teks = textOf(banner);
    expect(teks).toContain("Sesi terputus karena aplikasi berhenti.");
    expect(teks).toContain("Lanjutkan sesi");

    const tombol = buttons(banner)[0];
    expect(tombol).toBeDefined();
    ((tombol?.props as unknown) as { onClick: () => void }).onClick();
    expect(dipanggil).toBe(1);
  });

  test("tombol dinonaktifkan saat mengirim dan galat tampil sebaris", () => {
    const banner = ResumeBannerView({
      visible: true,
      busy: true,
      error: "gagal melanjutkan sesi",
      onContinue: (): void => undefined,
    });
    expect(textOf(banner)).toContain("Melanjutkan…");
    expect(textOf(banner)).toContain("gagal melanjutkan sesi");
    const tombol = buttons(banner)[0];
    expect(((tombol?.props as unknown) as { disabled: boolean }).disabled).toBe(true);
  });
});

describe("catatan sesi terputus", () => {
  test("memuat teks catatan yang sama di mana-mana", () => {
    expect(textOf(InterruptedNote())).toBe(PLAN_INTERRUPTED_NOTE);
    expect(PLAN_INTERRUPTED_NOTE).toBe(
      "Sesi sempat terputus. Menyetujui akan melanjutkan sesi dan agent mulai dari rencana ini.",
    );
  });
});
