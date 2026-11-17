import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { CommandEnvSectionView } from "../src/client/components/SecretsTab";
import type { CommandEnvState } from "../src/client/lib/api";

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

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function buttonTexts(node: ComponentChild): string[] {
  return buttons(node).map((vnode) => textOf(vnode.props.children as ComponentChild));
}

const NOOP = (): void => {};

function render(
  props: Partial<Parameters<typeof CommandEnvSectionView>[0]> = {},
): ComponentChild {
  return CommandEnvSectionView({
    state: undefined,
    loading: false,
    error: undefined,
    disabled: undefined,
    path: "",
    formError: undefined,
    saving: false,
    clearing: false,
    onPath: NOOP,
    onSave: NOOP,
    onClear: NOOP,
    onRetry: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

function state(overrides: Partial<CommandEnvState> = {}): CommandEnvState {
  return { keys: [], ...overrides };
}

describe("bagian env untuk perintah", () => {
  test("judul dan penjelasan selalu tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Env untuk perintah");
    expect(teks).toContain("Pilih berkas .env");
    expect(teks).toContain("agent hanya melihat nama kunci");
  });

  test("memuat tanpa pengaturan: kolom jalur dan tombol Simpan", () => {
    const pohon = render({ state: state(), loading: true });
    const inputs = findNodes(pohon, (vnode) => vnode.type === "input");
    expect(inputs.length).toBe(1);
    expect(propsOf(inputs[0])["value"]).toBe("");
    expect(buttonTexts(pohon)).toContain("Simpan");
  });

  test("menyimpan jalur memanggil onSave", () => {
    let saved = 0;
    const pohon = render({ state: state(), path: "/tmp/.env", onSave: () => (saved += 1) });
    const simpan = buttons(pohon).find((vnode) => textOf(vnode.props.children as ComponentChild) === "Simpan");
    (propsOf(simpan)["onClick"] as () => void)();
    expect(saved).toBe(1);
  });

  test("input jalur meneruskan onPath", () => {
    let value = "";
    const pohon = render({ state: state(), onPath: (next) => (value = next) });
    const input = findNodes(pohon, (vnode) => vnode.type === "input")[0];
    (propsOf(input)["onInput"] as (event: unknown) => void)({
      currentTarget: { value: "/a/.env" },
    });
    expect(value).toBe("/a/.env");
  });

  test("menampilkan kunci tanpa nilai", () => {
    const pohon = render({
      state: state({ path: "/tmp/proyek/.env", keys: ["API_KEY", "DB_URL"] }),
    });
    const teks = textOf(pohon);
    expect(teks).toContain("API_KEY");
    expect(teks).toContain("DB_URL");
    const kunci = findNodes(pohon, (vnode) => {
      const value = propsOf(vnode)["class"];
      return typeof value === "string" && value.split(" ").includes("jk-command-env-key");
    });
    expect(kunci.map((vnode) => textOf(vnode.props.children as ComponentChild))).toEqual([
      "API_KEY",
      "DB_URL",
    ]);
    expect(teks).toContain("Hapus");
  });

  test("menghapus memanggil onClear", () => {
    let cleared = 0;
    const pohon = render({
      state: state({ path: "/tmp/.env", keys: ["A"] }),
      onClear: () => (cleared += 1),
    });
    const hapus = buttons(pohon).find((vnode) => textOf(vnode.props.children as ComponentChild) === "Hapus");
    (propsOf(hapus)["onClick"] as () => void)();
    expect(cleared).toBe(1);
  });

  test("galat 400 tampil", () => {
    const teks = textOf(render({ state: state(), formError: "Berkas tidak ditemukan." }));
    expect(teks).toContain("Berkas tidak ditemukan.");
  });

  test("503 tampil pesan dimatikan", () => {
    const teks = textOf(render({ disabled: "Env perintah dimatikan." }));
    expect(teks).toContain("Env perintah dimatikan.");
    expect(buttonTexts(render({ disabled: "Env perintah dimatikan." }))).toEqual([]);
  });

  test("galat muat menampilkan tombol coba lagi", () => {
    let retried = 0;
    const pohon = render({ error: "env perintah tidak dapat dimuat", onRetry: () => (retried += 1) });
    expect(textOf(pohon)).toContain("env perintah tidak dapat dimuat");
    const coba = buttons(pohon).find((vnode) => textOf(vnode.props.children as ComponentChild) === "Coba lagi");
    (propsOf(coba)["onClick"] as () => void)();
    expect(retried).toBe(1);
  });
});
