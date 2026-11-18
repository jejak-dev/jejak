import { describe, expect, test } from "bun:test";
import type { DesignPage } from "../src/client/lib/api";
import {
  DEVICE_IDS,
  DEVICE_LABELS,
  DEVICE_SIZES,
  SAMPLE_PROMPT,
  deviceLabel,
  pageRows,
  shouldRefetch,
} from "../src/client/lib/design-ui";
import { DEVICES } from "../src/server/design/manifest";

function page(overrides: Partial<DesignPage> = {}): DesignPage {
  return {
    slug: "beranda",
    title: "Beranda",
    device: "desktop",
    x: 0,
    y: 0,
    mtime: 1,
    missing: false,
    tooLarge: false,
    ...overrides,
  };
}

describe("label perangkat", () => {
  test("label Bahasa Indonesia untuk setiap perangkat", () => {
    expect(DEVICE_LABELS).toEqual({
      desktop: "Desktop",
      tablet: "Tablet",
      mobile: "Mobile",
      "mobile-android": "Android",
    });
    for (const id of DEVICE_IDS) expect(deviceLabel(id)).toBe(DEVICE_LABELS[id]);
  });

  test("ukuran salinan sama dengan DEVICES di server", () => {
    expect(DEVICE_SIZES).toEqual(DEVICES);
    expect([...DEVICE_IDS].sort()).toEqual(
      (Object.keys(DEVICES) as Array<keyof typeof DEVICES>).sort(),
    );
  });
});

describe("pageRows", () => {
  test("baris mengikuti urutan manifest dengan label dan ukuran", () => {
    const rows = pageRows([
      page({ slug: "beranda", title: "Beranda", route: "/", device: "desktop" }),
      page({ slug: "profil", title: "Profil", device: "mobile" }),
    ]);
    expect(rows).toEqual([
      {
        slug: "beranda",
        title: "Beranda",
        route: "/",
        deviceLabel: "Desktop",
        sizeLabel: "1440 x 900",
        missing: false,
      },
      {
        slug: "profil",
        title: "Profil",
        deviceLabel: "Mobile",
        sizeLabel: "390 x 844",
        missing: false,
      },
    ]);
  });

  test("route kosong tidak disertakan dan missing diteruskan", () => {
    const [row] = pageRows([page({ missing: true })]);
    expect(row?.route).toBeUndefined();
    expect(row?.missing).toBe(true);
  });

  test("daftar kosong menghasilkan daftar kosong", () => {
    expect(pageRows([])).toEqual([]);
  });
});

describe("SAMPLE_PROMPT", () => {
  test("menyebut DESIGN.md, folder halaman, dan design.json", () => {
    expect(SAMPLE_PROMPT).toContain("design/DESIGN.md");
    expect(SAMPLE_PROMPT).toContain("design/pages/<slug>.html");
    expect(SAMPLE_PROMPT).toContain("design/design.json");
    expect(SAMPLE_PROMPT).toContain("beranda");
  });
});

describe("shouldRefetch", () => {
  test("true saat cap berbeda atau belum ada", () => {
    expect(shouldRefetch(undefined, "a")).toBe(true);
    expect(shouldRefetch("a", "b")).toBe(true);
  });

  test("false saat cap sama", () => {
    expect(shouldRefetch("a", "a")).toBe(false);
  });
});
