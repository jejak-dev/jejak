import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { AcpAgentSettingsView } from "../src/client/components/AcpAgentSettings";
import {
  acpStateLabel,
  parseAcpAgentList,
  parseAcpAgentStatus,
  type AcpAgentInfo,
  type AcpAgentStatus,
} from "../src/client/lib/acp-agents";

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

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

const NOOP = (): void => {};

const AGENT: AcpAgentInfo = {
  id: "antigravity",
  label: "Antigravity",
  installed: true,
  installHint: "Pasang agy dari rilis Antigravity.",
  loginHint: "Jalankan `agy acp --login`.",
};

function render(
  props: Partial<Parameters<typeof AcpAgentSettingsView>[0]> = {},
): ComponentChild {
  return AcpAgentSettingsView({
    agents: [AGENT],
    loading: false,
    error: undefined,
    statuses: {},
    probing: {},
    onProbe: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

function status(overrides: Partial<AcpAgentStatus> = {}): AcpAgentStatus {
  return { id: "antigravity", label: "Antigravity", state: "siap", ...overrides };
}

function probeButton(node: ComponentChild): VNode | undefined {
  return findNodes(node, (vnode) => typeof propsOf(vnode)["aria-label"] === "string")[0];
}

/* ---------- Parser dan label ---------- */

describe("parseAcpAgentList", () => {
  test("bentuk lengkap diterima", () => {
    const parsed = parseAcpAgentList({ agents: [AGENT] });
    expect(parsed).toEqual([AGENT]);
  });

  test("bentuk salah dilempar", () => {
    expect(() => parseAcpAgentList(null)).toThrow();
    expect(() => parseAcpAgentList({ agents: [{ id: "x" }] })).toThrow();
    expect(() => parseAcpAgentList({ agents: [{ ...AGENT, installed: "ya" }] })).toThrow();
  });
});

describe("parseAcpAgentStatus", () => {
  test("bentuk lengkap diterima", () => {
    const parsed = parseAcpAgentStatus({
      id: "antigravity",
      label: "Antigravity",
      state: "belum-login",
      hint: "login dulu",
      models: 2,
    });
    expect(parsed.state).toBe("belum-login");
    expect(parsed.models).toBe(2);
  });

  test("bentuk salah dan state tak dikenal dilempar", () => {
    expect(() => parseAcpAgentStatus(null)).toThrow();
    expect(() => parseAcpAgentStatus({ id: "x", label: "X", state: "entah" })).toThrow();
    expect(() => parseAcpAgentStatus({ id: "x", label: "X" })).toThrow();
  });
});

describe("acpStateLabel", () => {
  test("label Indonesia untuk setiap state dan belum diperiksa", () => {
    expect(acpStateLabel(undefined)).toBe("Belum diperiksa");
    expect(acpStateLabel("tidak-terpasang")).toBe("Tidak terpasang");
    expect(acpStateLabel("belum-login")).toBe("Belum login");
    expect(acpStateLabel("siap")).toBe("Siap");
    expect(acpStateLabel("galat")).toBe("Galat");
  });
});

/* ---------- Tampilan ---------- */

describe("AcpAgentSettingsView", () => {
  test("judul, paragraf bantuan, dan nama agent tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Agent eksternal");
    expect(teks).toContain("team_spawn");
    expect(teks).toContain("login dilakukan di terminal");
    expect(teks).toContain("Antigravity");
  });

  test("sebelum diperiksa, lencana Belum diperiksa dan tombol ber-aria-label", () => {
    const node = render();
    expect(textOf(node)).toContain("Belum diperiksa");
    const tombol = probeButton(node);
    expect(propsOf(tombol)["aria-label"]).toBe("Periksa Antigravity");
    expect(textOf(tombol as unknown as ComponentChild)).toContain("Periksa");
  });

  test("tidak terpasang menampilkan installHint", () => {
    const node = render({
      agents: [{ ...AGENT, installed: false }],
      statuses: { antigravity: status({ state: "tidak-terpasang", hint: "Pasang agy dari rilis." }) },
    });
    const teks = textOf(node);
    expect(teks).toContain("Tidak terpasang");
    expect(teks).toContain("Pasang agy dari rilis.");
  });

  test("tidak terpasang dari daftar awal memakai installHint agent", () => {
    const node = render({ agents: [{ ...AGENT, installed: false }] });
    expect(textOf(node)).toContain("Tidak terpasang");
    expect(textOf(node)).toContain("Pasang agy dari rilis Antigravity.");
  });

  test("belum login menampilkan loginHint", () => {
    const node = render({
      statuses: {
        antigravity: status({ state: "belum-login", hint: "Jalankan `agy acp --login`." }),
      },
    });
    const teks = textOf(node);
    expect(teks).toContain("Belum login");
    expect(teks).toContain("agy acp --login");
  });

  test("siap menampilkan jumlah model", () => {
    const node = render({ statuses: { antigravity: status({ state: "siap", models: 4 }) } });
    const teks = textOf(node);
    expect(teks).toContain("Siap");
    expect(teks).toContain("4 model");
  });

  test("galat menampilkan detail", () => {
    const node = render({
      statuses: {
        antigravity: status({ state: "galat", detail: "proses keluar dengan kode 1" }),
      },
    });
    const teks = textOf(node);
    expect(teks).toContain("Galat");
    expect(teks).toContain("proses keluar dengan kode 1");
  });

  test("sedang memeriksa: tombol nonaktif dan berlabel Memeriksa…", () => {
    const node = render({ probing: { antigravity: true } });
    const tombol = probeButton(node);
    expect(propsOf(tombol)["disabled"]).toBe(true);
    expect(textOf(tombol as unknown as ComponentChild)).toContain("Memeriksa…");
  });

  test("galat jaringan tampil sebaris dengan peran alert", () => {
    const node = render({ error: "tidak dapat terhubung ke server" });
    const alert = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alert");
    expect(alert).toHaveLength(1);
    expect(textOf(node)).toContain("tidak dapat terhubung ke server");
  });
});
