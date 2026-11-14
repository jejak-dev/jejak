import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { FeatureSettingsView } from "../src/client/components/FeatureSettings";
import {
  featureErrorMessage,
  featureOffHint,
  parseFeatureStatus,
  type FeatureStatus,
} from "../src/client/lib/features";

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

function switches(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => propsOf(vnode)["role"] === "switch");
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

const NOOP = (): void => {};

function status(overrides: Partial<FeatureStatus> = {}): FeatureStatus {
  return {
    terminal: { enabled: false, locked: false },
    browser: { enabled: false, locked: false },
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof FeatureSettingsView>[0]> = {}): ComponentChild {
  return FeatureSettingsView({
    status: status(),
    loading: false,
    error: undefined,
    confirm: undefined,
    onToggle: NOOP,
    onConfirm: NOOP,
    onCancel: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

/* ---------- Logika murni ---------- */

describe("parseFeatureStatus", () => {
  test("bentuk lengkap diterima", () => {
    const parsed = parseFeatureStatus({
      terminal: { enabled: true, locked: false },
      browser: { enabled: false, locked: true },
    });
    expect(parsed).toEqual({
      terminal: { enabled: true, locked: false },
      browser: { enabled: false, locked: true },
    });
  });

  test("bentuk asing ditolak", () => {
    expect(parseFeatureStatus(null)).toBeUndefined();
    expect(parseFeatureStatus({ terminal: { enabled: true } })).toBeUndefined();
    expect(parseFeatureStatus({ terminal: { enabled: "ya", locked: false }, browser: {} })).toBeUndefined();
  });
});

describe("featureOffHint", () => {
  test("fitur yang bisa dinyalakan menyebut Pengaturan", () => {
    const hint = featureOffHint("terminal", { enabled: false, locked: false });
    expect(hint.locked).toBe(false);
    expect(hint.text).toContain("Pengaturan");
    expect(hint.env).toBe("JEJAK_TERMINAL");
  });

  test("fitur terkunci env menyebut variabel lingkungan", () => {
    const hint = featureOffHint("browser", { enabled: false, locked: true });
    expect(hint.locked).toBe(true);
    expect(hint.text).toContain("JEJAK_BROWSER");
  });
});

describe("featureErrorMessage", () => {
  test("pesan galat API dipakai apa adanya", () => {
    expect(featureErrorMessage(new Error("Fitur terminal dikunci."))).toBe(
      "Fitur terminal dikunci.",
    );
    expect(featureErrorMessage(undefined)).toBe("Permintaan gagal.");
  });
});

/* ---------- Tampilan ---------- */

describe("FeatureSettingsView", () => {
  test("kartu memuat judul dan dua fitur", () => {
    const teks = textOf(render());
    expect(teks).toContain("Fitur");
    expect(teks).toContain("Terminal");
    expect(teks).toContain("Browser");
    expect(teks).toContain("Akses shell penuh");
    expect(teks).toContain("Chromium terpisah");
  });

  test("saklar punya aria-label Bahasa Indonesia dan status awal mati", () => {
    const daftar = switches(render());
    expect(daftar).toHaveLength(2);
    expect(propsOf(daftar[0])["aria-label"]).toBe("Nyalakan terminal");
    expect(propsOf(daftar[0])["aria-checked"]).toBe("false");
    expect(propsOf(daftar[1])["aria-label"]).toBe("Nyalakan browser");
  });

  test("saklar menyala memakai label Matikan dan aria-checked true", () => {
    const daftar = switches(render({ status: status({ terminal: { enabled: true, locked: false } }) }));
    expect(propsOf(daftar[0])["aria-label"]).toBe("Matikan terminal");
    expect(propsOf(daftar[0])["aria-checked"]).toBe("true");
  });

  test("saklar terkunci dinonaktifkan dan env disebut", () => {
    const daftar = switches(
      render({ status: status({ terminal: { enabled: false, locked: true } }) }),
    );
    expect(propsOf(daftar[0])["disabled"]).toBe(true);
    expect(textOf(render({ status: status({ terminal: { enabled: false, locked: true } }) }))).toContain(
      "Dikunci oleh variabel lingkungan JEJAK_TERMINAL",
    );
  });

  test("modal muncul hanya saat menyalakan", () => {
    const tanpa = render();
    expect(textOf(tanpa)).not.toContain("Nyalakan terminal?");
    expect(byClass(tanpa, "jk-confirm-card").length).toBe(0);

    const dengan = render({ confirm: "terminal" });
    expect(textOf(dengan)).toContain("Nyalakan terminal?");
    const kartu = byClass(dengan, "jk-confirm-card-danger");
    expect(kartu).toHaveLength(1);
  });

  test("modal browser tidak memakai nada danger", () => {
    const dengan = render({ confirm: "browser" });
    expect(textOf(dengan)).toContain("Nyalakan browser?");
    expect(byClass(dengan, "jk-confirm-card-danger").length).toBe(0);
  });

  test("galat tampil sebaris dengan peran alert", () => {
    const node = render({ error: "Fitur terminal dikunci oleh variabel lingkungan JEJAK_TERMINAL." });
    const alert = findNodes(node, (vnode) => propsOf(vnode)["role"] === "alert");
    expect(alert).toHaveLength(1);
    expect(textOf(node)).toContain("dikunci");
  });

  test("saat memuat, tak ada saklar yang tampil", () => {
    const node = render({ loading: true, status: undefined });
    expect(textOf(node)).toContain("Memuat fitur");
    expect(switches(node)).toHaveLength(0);
  });
});
