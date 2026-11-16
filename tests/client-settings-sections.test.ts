import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseHashRoute,
  SETTINGS_SECTIONS,
  settingsHash,
  type SettingsSection,
} from "../src/client/lib/format";

const root = join(import.meta.dir, "..");

describe("parseHashRoute bagian Pengaturan", () => {
  test("jalur bawaan tidak punya field section", () => {
    expect(parseHashRoute("#/providers")).toEqual({ view: "providers" });
  });

  test("empat bagian menghasilkan view providers plus section", () => {
    expect(parseHashRoute("#/providers/keamanan")).toEqual({
      view: "providers",
      section: "keamanan",
    });
    expect(parseHashRoute("#/providers/biaya")).toEqual({
      view: "providers",
      section: "biaya",
    });
    expect(parseHashRoute("#/providers/fitur")).toEqual({
      view: "providers",
      section: "fitur",
    });
    expect(parseHashRoute("#/providers/sistem")).toEqual({
      view: "providers",
      section: "sistem",
    });
  });

  test("bagian tak dikenal dan slash akhir kosong", () => {
    expect(parseHashRoute("#/providers/entah")).toEqual({});
    expect(parseHashRoute("#/providers/keamanan/")).toEqual({});
    expect(parseHashRoute("#/providers/")).toEqual({});
  });
});

describe("settingsHash", () => {
  test("provider memakai jalur bawaan", () => {
    expect(settingsHash("provider")).toBe("#/providers");
  });

  test("bagian lain memakai jalur bertingkat", () => {
    expect(settingsHash("keamanan")).toBe("#/providers/keamanan");
    expect(settingsHash("biaya")).toBe("#/providers/biaya");
    expect(settingsHash("fitur")).toBe("#/providers/fitur");
    expect(settingsHash("sistem")).toBe("#/providers/sistem");
  });
});

describe("SETTINGS_SECTIONS", () => {
  test("lima id unik dengan urutan yang ditentukan", () => {
    expect(SETTINGS_SECTIONS.map((item) => item.id)).toEqual([
      "provider",
      "keamanan",
      "biaya",
      "fitur",
      "sistem",
    ]);
  });

  test("label Bahasa Indonesia", () => {
    expect(SETTINGS_SECTIONS.map((item) => item.label)).toEqual([
      "Provider",
      "Keamanan",
      "Biaya",
      "Fitur",
      "Sistem",
    ]);
  });
});

describe("pembagian halaman Pengaturan", () => {
  test("ProviderSettings tak lagi memuat bagian pengaturan lain", () => {
    const sumber = readFileSync(
      join(root, "src/client/components/ProviderSettings.tsx"),
      "utf8",
    );
    for (const nama of ["BudgetSettings", "SandboxSettings", "AppUpdateSettings", "SdkSettings"]) {
      expect(sumber).not.toContain(nama);
    }
  });

  test("app.tsx memetakan tiap bagian ke komponennya", () => {
    const sumber = readFileSync(join(root, "src/client/app.tsx"), "utf8");
    expect(sumber).toContain("<SettingsNav section={settingsSection} />");
    expect(sumber).toContain("<SandboxSettings api={api} />");
    expect(sumber).toContain("<AccessSettings api={api} onAuthChanged={refreshAuth} />");
    expect(sumber).toContain("<BudgetSettings api={api} />");
    expect(sumber).toContain("<FeatureSettings api={api} />");
    expect(sumber).toContain("<AppUpdateSettings sessions={sessions} />");
    expect(sumber).toContain("<SdkSettings api={api} />");
  });
});

describe("SettingsNav", () => {
  test("tautan memakai hash bagian dan menandai bagian aktif", async () => {
    const { SettingsNav } = await import("../src/client/components/SettingsNav");
    const vnode = SettingsNav({ section: "biaya" }) as {
      props: { children: { props: Record<string, unknown> }[] };
    };
    const tautan = vnode.props.children as {
      props: Record<string, unknown>;
    }[];
    expect(tautan.length).toBe(5);
    const href = tautan.map((item) => item.props.href);
    expect(href).toEqual([
      "#/providers",
      "#/providers/keamanan",
      "#/providers/biaya",
      "#/providers/fitur",
      "#/providers/sistem",
    ]);
    const aktif = tautan.filter((item) => item.props["aria-current"] === "page");
    expect(aktif.length).toBe(1);
    expect(aktif[0]?.props.href).toBe("#/providers/biaya");
  });

  test("bagian aktif yang lain menandai tautan yang sesuai", async () => {
    const { SettingsNav } = await import("../src/client/components/SettingsNav");
    const vnode = SettingsNav({ section: "provider" }) as {
      props: { children: { props: Record<string, unknown> }[] };
    };
    const tautan = vnode.props.children as { props: Record<string, unknown> }[];
    const aktif = tautan.filter((item) => item.props["aria-current"] === "page");
    expect(aktif.length).toBe(1);
    expect(aktif[0]?.props.href).toBe("#/providers");
  });
});

describe("tipe bagian", () => {
  test("id bagian recognised", () => {
    const ids: SettingsSection[] = SETTINGS_SECTIONS.map((item) => item.id);
    expect(ids).toHaveLength(5);
  });
});
