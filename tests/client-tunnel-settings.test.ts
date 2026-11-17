import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { TunnelSettingsView } from "../src/client/components/TunnelSettings";
import type { TunnelStatus } from "../src/client/lib/tunnel-form";

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

function status(overrides: Partial<TunnelStatus> = {}): TunnelStatus {
  return {
    installed: true,
    enabled: false,
    running: false,
    hasToken: false,
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof TunnelSettingsView>[0]> = {},
): ComponentChild {
  return TunnelSettingsView({
    status: status(),
    networkEnabled: true,
    networkPort: 4747,
    busy: false,
    error: undefined,
    readOnly: false,
    publicHost: "jejak.contoh.com",
    token: "",
    onPublicHost: NOOP,
    onToken: NOOP,
    onToggle: NOOP,
    onDeleteToken: NOOP,
    confirmOpen: false,
    onConfirmDelete: NOOP,
    onCancelDelete: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

describe("bagian tunnel Cloudflare", () => {
  test("judul, penjelasan, dan tiga langkah tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Akses dari mana saja (Cloudflare)");
    expect(teks).toContain("Buat tunnel di dashboard Cloudflare.");
    expect(teks).toContain("http://localhost:4747");
    expect(teks).toContain("Tempel token tunnel di sini.");
  });

  test("kolom hostname dan token tampil; token bertipe password", () => {
    const inputs = findNodes(render(), (vnode) => vnode.type === "input");
    expect(inputs.length).toBe(2);
    expect(propsOf(inputs[0])["type"]).toBe("text");
    expect(propsOf(inputs[0])["placeholder"]).toBe("jejak.contoh.com");
    expect(propsOf(inputs[1])["type"]).toBe("password");
    expect(propsOf(inputs[1])["autoComplete"]).toBe("off");
  });

  test("token tersimpan memakai placeholder, bukan nilainya", () => {
    const inputs = findNodes(
      render({ status: status({ hasToken: true }) }),
      (vnode) => vnode.type === "input",
    );
    expect(propsOf(inputs[1])["placeholder"]).toBe("Token tersimpan");
    expect(propsOf(inputs[1])["value"]).toBe("");
  });

  test("tombol Hapus token hanya ada bila token tersimpan", () => {
    expect(buttonTexts(render())).toEqual(["Aktifkan"]);
    expect(buttonTexts(render({ status: status({ hasToken: true }) }))).toEqual([
      "Aktifkan",
      "Hapus token",
    ]);
  });

  test("tunnel menyala: tombol Matikan dan lencana Berjalan", () => {
    const pohon = render({ status: status({ enabled: true, running: true }) });
    expect(textOf(pohon)).toContain("Berjalan");
    expect(buttonTexts(pohon)).toContain("Matikan");
  });

  test("tunnel mati: lencana Mati", () => {
    expect(textOf(render())).toContain("Mati");
  });

  test("URL publik tampil sebagai tautan", () => {
    const tautan = findNodes(
      render({ status: status({ enabled: true, url: "https://jejak.contoh.com" }) }),
      (vnode) => vnode.type === "a",
    );
    expect(tautan.length).toBe(1);
    expect(propsOf(tautan[0])["href"]).toBe("https://jejak.contoh.com");
  });

  test("galat dan baris log terakhir tampil", () => {
    const teks = textOf(
      render({
        status: status({ error: "cloudflared berhenti.", lastLine: "connection refused" }),
      }),
    );
    expect(teks).toContain("cloudflared berhenti.");
    expect(teks).toContain("connection refused");
  });

  test("syarat belum lengkap: tombol nonaktif dengan alasan", () => {
    const pohon = render({ networkEnabled: false });
    const tombol = buttons(pohon)[0];
    expect(propsOf(tombol)["disabled"]).toBe(true);
    expect(textOf(pohon)).toContain("Nyalakan akses dari jaringan dulu.");
  });

  test("cloudflared belum terpasang: perintah pemasangan tampil", () => {
    const teks = textOf(render({ status: status({ installed: false }) }));
    expect(teks).toContain("cloudflared belum terpasang");
    expect(teks).toContain("brew install cloudflared");
  });

  test("read-only: tanpa kolom dan tombol ubah", () => {
    const pohon = render({ readOnly: true });
    expect(findNodes(pohon, (vnode) => vnode.type === "input").length).toBe(0);
    expect(buttonTexts(pohon)).toEqual([]);
    expect(textOf(pohon)).toContain(
      "Pengaturan ini hanya bisa diubah dari komputer yang menjalankan Jejak.",
    );
  });

  test("modal hapus token hanya tampil saat dibuka", () => {
    expect(textOf(render({ confirmOpen: true }))).toContain("Hapus token tunnel?");
    expect(textOf(render())).not.toContain("Hapus token tunnel?");
  });
});
