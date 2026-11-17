import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { NetworkSettingsView } from "../src/client/components/NetworkSettings";
import type { NetworkStatus } from "../src/client/lib/network-form";

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

function findNodes(
  node: ComponentChild,
  predicate: (vnode: VNode) => boolean,
): VNode[] {
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

function status(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    enabled: false,
    port: 4747,
    listening: false,
    urls: [],
    passwordRequired: false,
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof NetworkSettingsView>[0]> = {},
): ComponentChild {
  return NetworkSettingsView({
    status: status(),
    busy: false,
    error: undefined,
    port: "4747",
    onPort: NOOP,
    onToggle: NOOP,
    ...props,
  }) as unknown as ComponentChild;
}

describe("bagian akses dari jaringan", () => {
  test("judul, tombol, dan kolom port tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Akses dari jaringan");
    expect(teks).toContain("Izinkan akses dari perangkat lain");
    expect(teks).toContain("Port");
    const inputs = findNodes(render(), (vnode) => vnode.type === "input");
    expect(inputs.length).toBe(1);
    expect(propsOf(inputs[0])["value"]).toBe("4747");
  });

  test("status mati saat listener tak menyala", () => {
    expect(textOf(render())).toContain("Mati");
  });

  test("status menyala menampilkan daftar URL dengan tombol Salin", () => {
    const pohon = render({
      status: status({
        enabled: true,
        listening: true,
        urls: ["http://192.168.1.5:4747", "http://10.0.0.3:4747"],
      }),
    });
    const teks = textOf(pohon);
    expect(teks).toContain("Mendengarkan di:");
    expect(teks).toContain("http://192.168.1.5:4747");
    expect(teks).toContain("http://10.0.0.3:4747");
    const salin = buttons(pohon).filter((vnode) =>
      String(propsOf(vnode)["aria-label"] ?? "").startsWith("Salin "),
    );
    expect(salin.length).toBe(2);
  });

  test("tanpa sandi: tombol nonaktif dan petunjuk tampil", () => {
    const pohon = render({ status: status({ passwordRequired: true }) });
    expect(textOf(pohon)).toContain("Buat sandi dulu");
    const tombol = buttons(pohon)[0];
    expect(propsOf(tombol)["disabled"]).toBe(true);
  });

  test("kolom port tak bisa diubah saat listener menyala", () => {
    const pohon = render({
      status: status({ enabled: true, listening: true }),
    });
    const inputs = findNodes(pohon, (vnode) => vnode.type === "input");
    expect(propsOf(inputs[0])["disabled"]).toBe(true);
  });

  test("kolom port bisa diubah saat mati", () => {
    const inputs = findNodes(render(), (vnode) => vnode.type === "input");
    expect(propsOf(inputs[0])["disabled"]).toBe(false);
  });

  test("galat ditampilkan", () => {
    expect(textOf(render({ error: "Port 4747 sudah dipakai proses lain." }))).toContain(
      "Port 4747 sudah dipakai proses lain.",
    );
  });

  test("galat dari server ditampilkan", () => {
    const teks = textOf(
      render({
        status: status({ error: "Port 4747 sudah dipakai proses lain." }),
      }),
    );
    expect(teks).toContain("Port 4747 sudah dipakai proses lain.");
  });

  test("akses diizinkan tapi listener mati: tombol untuk mematikan", () => {
    const teks = textOf(render({ status: status({ enabled: true, listening: false }) }));
    expect(teks).toContain("Matikan akses dari perangkat lain");
    expect(teks).toContain("Mati");
  });

  test("peringatan keamanan dan catatan firewall selalu tampil", () => {
    const teks = textOf(render());
    expect(teks).toContain("Tailscale");
    expect(teks).toContain("HTTP biasa");
    expect(teks).toContain("terima koneksi masuk");
  });

  test("tombol berubah label saat akses menyala", () => {
    const teks = textOf(
      render({ status: status({ enabled: true, listening: true }) }),
    );
    expect(teks).toContain("Matikan akses dari perangkat lain");
    expect(buttonTexts(render())).toEqual(["Izinkan akses dari perangkat lain"]);
  });

  test("status tampil sebagai lencana dengan titik berwarna", () => {
    const mati = findNodes(render(), (vnode) => {
      const value = propsOf(vnode)["class"];
      return typeof value === "string" && value.split(" ").includes("jk-status-badge");
    });
    expect(mati.length).toBe(1);
    expect(textOf(mati[0]?.props.children as ComponentChild)).toBe("Mati");
    expect(
      findNodes(mati[0] as ComponentChild, (vnode) => {
        const value = propsOf(vnode)["class"];
        return typeof value === "string" && value.split(" ").includes("jk-dot");
      }).length,
    ).toBe(1);

    const nyala = findNodes(
      render({ status: status({ enabled: true, listening: true }) }),
      (vnode) => {
        const value = propsOf(vnode)["class"];
        return typeof value === "string" && value.split(" ").includes("jk-status-badge-on");
      },
    );
    expect(nyala.length).toBe(1);
    expect(textOf(nyala[0]?.props.children as ComponentChild)).toBe("Aktif");
  });

  test("alasan tombol nonaktif tampil tepat setelah tombol", () => {
    const pohon = render({ status: status({ passwordRequired: true }) });
    const anak = (pohon as VNode).props.children as ComponentChild[];
    const daftar = Array.isArray(anak) ? anak : [anak];
    const indeksTombol = daftar.findIndex(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as VNode).type === "div" &&
        String(propsOf(item as VNode)["class"] ?? "").includes("jk-network-actions"),
    );
    expect(indeksTombol).toBeGreaterThan(-1);
    const sesudah = daftar[indeksTombol + 1];
    expect(textOf(sesudah as ComponentChild)).toBe("Buat sandi dulu");
  });

  test("autentikasi tidak aktif: tombol nonaktif dengan alasan Butuh sandi", () => {
    const pohon = render({ authDisabled: true });
    expect(propsOf(buttons(pohon)[0])["disabled"]).toBe(true);
    expect(textOf(pohon)).toContain("Butuh sandi");
  });
});
