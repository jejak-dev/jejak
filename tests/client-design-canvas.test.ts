import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  boundsOf,
  centerOn,
  clampZoom,
  fitView,
  frameHeight,
  frameRects,
  panBy,
  pickLive,
  screenToWorld,
  snap,
  stepZoom,
  visibleSlugs,
  wheelAction,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Rect,
  type View,
} from "../src/client/lib/design-canvas";
import { DEVICE_SIZES } from "../src/client/lib/design-ui";

const VIEW: View = { x: 100, y: 50, zoom: 2 };

function rect(x: number, y: number, width = 100, height = 100): Rect {
  return { x, y, width, height };
}

describe("clampZoom", () => {
  test("menjepit ke 0.1..4", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  test("nilai tak hingga jatuh ke 1", () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("zoomAt", () => {
  test("titik dunia di bawah jangkar tetap di tempat", () => {
    const anchor = { x: 300, y: 200 };
    const world = screenToWorld(VIEW, anchor);
    const next = zoomAt(VIEW, 3, anchor);
    const screen = worldToScreen(next, world);
    expect(screen.x).toBeCloseTo(anchor.x, 6);
    expect(screen.y).toBeCloseTo(anchor.y, 6);
    expect(next.zoom).toBe(3);
  });

  test("zoom dijepit", () => {
    expect(zoomAt(VIEW, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
  });
});

describe("zoomBy", () => {
  test("mengalikan zoom dan menjaga jangkar", () => {
    const anchor = { x: 10, y: 20 };
    const world = screenToWorld(VIEW, anchor);
    const next = zoomBy(VIEW, 0.5, anchor);
    expect(next.zoom).toBe(1);
    const screen = worldToScreen(next, world);
    expect(screen.x).toBeCloseTo(anchor.x, 6);
    expect(screen.y).toBeCloseTo(anchor.y, 6);
  });
});

describe("panBy", () => {
  test("menggeser tanpa mengubah zoom", () => {
    expect(panBy(VIEW, 10, -5)).toEqual({ x: 110, y: 45, zoom: 2 });
  });
});

describe("screenToWorld / worldToScreen", () => {
  test("bolak-balik mengembalikan titik semula", () => {
    const p = { x: 123.5, y: -44 };
    const world = screenToWorld(VIEW, p);
    const back = worldToScreen(VIEW, world);
    expect(back.x).toBeCloseTo(p.x, 6);
    expect(back.y).toBeCloseTo(p.y, 6);
  });
});

describe("frameHeight", () => {
  test("minimal tinggi preset", () => {
    expect(frameHeight(900, undefined)).toBe(900);
    expect(frameHeight(900, 0)).toBe(900);
    expect(frameHeight(900, 300)).toBe(900);
  });

  test("mengikuti isi dan dibatasi 6000", () => {
    expect(frameHeight(900, 1200.2)).toBe(1201);
    expect(frameHeight(900, 99999)).toBe(6000);
  });
});

describe("frameRects", () => {
  test("memakai ukuran perangkat dan tinggi isi", () => {
    const rects = frameRects(
      [
        { slug: "a", x: 0, y: 0, device: "desktop" },
        { slug: "b", x: 2000, y: 0, device: "mobile" },
      ],
      { b: 1200 },
    );
    expect(rects[0]).toEqual({
      slug: "a",
      x: 0,
      y: 0,
      width: DEVICE_SIZES.desktop.width,
      height: DEVICE_SIZES.desktop.height,
    });
    expect(rects[1]).toEqual({
      slug: "b",
      x: 2000,
      y: 0,
      width: DEVICE_SIZES.mobile.width,
      height: 1200,
    });
  });
});

describe("boundsOf", () => {
  test("kosong mengembalikan undefined", () => {
    expect(boundsOf([])).toBe(undefined);
  });

  test("banyak kotak digabung", () => {
    expect(boundsOf([rect(0, 0, 100, 50), rect(200, 100, 50, 50)])).toEqual({
      x: 0,
      y: 0,
      width: 250,
      height: 150,
    });
  });
});

describe("fitView", () => {
  test("tanpa frame mengembalikan tampilan awal", () => {
    expect(fitView([], { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  test("zoom paling besar 1 dan dipusatkan", () => {
    const view = fitView([rect(0, 0, 100, 100)], { width: 800, height: 600 });
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(350);
    expect(view.y).toBe(250);
  });

  test("frame besar diperkecil agar muat", () => {
    const view = fitView([rect(0, 0, 2000, 1000)], { width: 1000, height: 600 }, 0);
    expect(view.zoom).toBeCloseTo(0.5, 6);
    expect(view.x).toBeCloseTo(0, 6);
    expect(view.y).toBeCloseTo(50, 6);
  });
});

describe("centerOn", () => {
  test("memusatkan tanpa mengubah zoom", () => {
    const view = centerOn({ x: 0, y: 0, zoom: 2 }, rect(100, 100, 200, 100), {
      width: 800,
      height: 600,
    });
    expect(view.zoom).toBe(2);
    expect(view.x).toBe(400 - 200 * 2);
    expect(view.y).toBe(300 - 150 * 2);
  });
});

describe("snap", () => {
  test("membulatkan ke kelipatan 8", () => {
    expect(snap(11)).toBe(8);
    expect(snap(13)).toBe(16);
    expect(snap(-11)).toBe(-8);
    expect(snap(12.4, 4)).toBe(12);
  });

  test("nol tidak menjadi -0", () => {
    expect(Object.is(snap(-1), 0)).toBe(true);
  });
});

describe("visibleSlugs", () => {
  const rects = [
    { slug: "dalam", ...rect(0, 0, 100, 100) },
    { slug: "luar", ...rect(5000, 5000, 100, 100) },
    { slug: "margin", ...rect(900, 0, 100, 100) },
  ];
  const view: View = { x: 0, y: 0, zoom: 1 };
  const viewport = { width: 800, height: 600 };

  test("hanya yang beririsan dengan viewport", () => {
    expect(visibleSlugs(rects, view, viewport, 0)).toEqual(["dalam"]);
  });

  test("margin layar menambah yang dekat", () => {
    expect(visibleSlugs(rects, view, viewport, 200)).toEqual(["dalam", "margin"]);
  });
});

describe("pickLive", () => {
  const rects = [
    { slug: "a", ...rect(0, 0) },
    { slug: "b", ...rect(1000, 0) },
    { slug: "c", ...rect(2000, 0) },
  ];
  const view: View = { x: 0, y: 0, zoom: 1 };
  const viewport = { width: 100, height: 100 };

  test("di bawah batas mengembalikan semua", () => {
    expect(pickLive(["a", "b"], rects, view, viewport, 12)).toEqual(["a", "b"]);
  });

  test("di atas batas memilih yang terdekat ke pusat viewport", () => {
    expect(pickLive(["a", "b", "c"], rects, view, viewport, 2)).toEqual(["a", "b"]);
  });

  test("urutan hasil stabil mengikuti masukan", () => {
    expect(pickLive(["c", "a", "b"], rects, view, viewport, 2)).toEqual(["a", "b"]);
  });
});

describe("wheelAction", () => {
  test("Ctrl dan Cmd menjadi zoom", () => {
    const ctrl = wheelAction({ ctrlKey: true, metaKey: false, deltaX: 0, deltaY: -100, deltaMode: 0 });
    expect(ctrl.kind).toBe("zoom");
    if (ctrl.kind === "zoom") expect(ctrl.factor).toBeGreaterThan(1);
    const meta = wheelAction({ ctrlKey: false, metaKey: true, deltaX: 0, deltaY: 100, deltaMode: 0 });
    expect(meta.kind).toBe("zoom");
    if (meta.kind === "zoom") expect(meta.factor).toBeLessThan(1);
  });

  test("tanpa modifier menjadi geser", () => {
    expect(
      wheelAction({ ctrlKey: false, metaKey: false, deltaX: 10, deltaY: 20, deltaMode: 0 }),
    ).toEqual({ kind: "pan", dx: -10, dy: -20 });
  });

  test("deltaMode baris dan halaman diskalakan", () => {
    expect(
      wheelAction({ ctrlKey: false, metaKey: false, deltaX: 1, deltaY: 1, deltaMode: 1 }),
    ).toEqual({ kind: "pan", dx: -16, dy: -16 });
    expect(
      wheelAction({ ctrlKey: false, metaKey: false, deltaX: 1, deltaY: 1, deltaMode: 2 }),
    ).toEqual({ kind: "pan", dx: -100, dy: -100 });
  });

  test("faktor zoom dijepit 0.5..2 per peristiwa", () => {
    const besar = wheelAction({ ctrlKey: true, metaKey: false, deltaX: 0, deltaY: -10000, deltaMode: 0 });
    if (besar.kind === "zoom") expect(besar.factor).toBe(2);
    const kecil = wheelAction({ ctrlKey: true, metaKey: false, deltaX: 0, deltaY: 10000, deltaMode: 0 });
    if (kecil.kind === "zoom") expect(kecil.factor).toBe(0.5);
  });
});

describe("stepZoom", () => {
  test("naik ke langkah berikutnya", () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(0.1, 1)).toBe(0.25);
  });

  test("turun ke langkah sebelumnya", () => {
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.3, -1)).toBe(0.25);
  });

  test("berhenti di batas", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_ZOOM);
  });
});

describe("sumber iframe", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "client", "components", "DesignFrame.tsx"),
    "utf8",
  );

  test("sandbox hanya allow-scripts tanpa allow-same-origin", () => {
    expect(source).toContain('sandbox="allow-scripts"');
    expect(source).not.toContain("allow-same-origin");
  });

  test("memakai srcdoc dan referrerpolicy no-referrer", () => {
    expect(source).toContain("srcdoc={html}");
    expect(source).toContain('referrerpolicy="no-referrer"');
  });
});
