import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, type ApiClient, type DesignResult, type DeviceId } from "../lib/api";
import {
  centerOn,
  fitView,
  frameRects,
  panBy,
  pickLive,
  snap,
  stepZoom,
  visibleSlugs,
  wheelAction,
  worldToScreen,
  zoomAt,
  zoomBy,
  type Rect,
  type Size,
  type View,
} from "../lib/design-canvas";
import {
  clearSelectionMessage,
  isFromFrame,
  modeMessage,
  parseFrameMessage,
} from "../lib/design-protocol";
import {
  chipText,
  elementContext,
  overlayBorder,
  overlayRect,
  pageFile,
  styleRows,
  type Hover,
  type Selection,
} from "../lib/design-select";
import { targetKindOf } from "../lib/shortcuts";
import { CopyButton } from "./CopyButton";
import { DesignFrame } from "./DesignFrame";

export interface DesignCanvasProps {
  api: ApiClient;
  sessionId: string;
  /** Nama repo workspace; undefined berarti repo utama (cwd sesi). */
  repo?: string;
  design: DesignResult;
  refresh: () => Promise<void>;
  onExit: () => void;
  /** Tempel teks ke kolom pesan; tidak mengirim apa pun. */
  onQuote: (text: string) => void;
}

interface Override {
  x: number;
  y: number;
  device?: DeviceId;
}

interface Doc {
  html: string;
  mtime: number;
  warnings: number;
}

const SAVE_DEBOUNCE_MS = 500;
const EMPTY_TEXT = "Belum ada halaman. Minta agent merancang halaman pertama.";

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : "tata letak tidak dapat disimpan";
}

/**
 * Kanvas desain: dunia tak terbatas berisi frame halaman, zoom/geser, dan
 * penyimpanan posisi. Chrome melayang di atas kanvas dan tidak mengubah
 * ukuran dunia.
 */
export function DesignCanvas(props: DesignCanvasProps) {
  const { api, sessionId, repo, design, refresh, onExit } = props;

  const containerRef = useRef<HTMLElement | null>(null);
  const frameEls = useRef(new Map<string, HTMLIFrameElement>());
  const refCallbacks = useRef(new Map<string, (el: HTMLIFrameElement | null) => void>());
  const loadingRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, Override>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fitDone = useRef(false);
  const panDrag = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const frameDrag = useRef<{
    slug: string;
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
  } | null>(null);

  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [tool, setTool] = useState<"select" | "pan" | "preview">("pan");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [contentHeights, setContentHeights] = useState<Record<string, number>>({});
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [hover, setHover] = useState<Hover | undefined>(undefined);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [selectionLabel, setSelectionLabel] = useState("");
  const [infoOpen, setInfoOpen] = useState(true);

  const viewRef = useRef(view);
  viewRef.current = view;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const selectionMtimeRef = useRef<number | undefined>(undefined);
  const lastHoverRef = useRef<{ slug: string; label: string } | undefined>(undefined);

  const pages = design.pages.map((page) => {
    const override = overrides[page.slug];
    if (override === undefined) return page;
    return {
      ...page,
      x: override.x,
      y: override.y,
      device: override.device ?? page.device,
    };
  });
  const rects = frameRects(pages, contentHeights);
  const rectsRef = useRef(rects);
  rectsRef.current = rects;

  const visible = visibleSlugs(rects, view, viewport);
  const live = pickLive(visible, rects, view, viewport);
  const liveSet = new Set(live);
  const liveKey = live.join(",");

  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));
  const pageBySlugRef = useRef(pageBySlug);
  pageBySlugRef.current = pageBySlug;

  const frameRefFor = (slug: string): ((el: HTMLIFrameElement | null) => void) => {
    let callback = refCallbacks.current.get(slug);
    if (callback === undefined) {
      callback = (el) => {
        if (el === null) frameEls.current.delete(slug);
        else frameEls.current.set(slug, el);
      };
      refCallbacks.current.set(slug, callback);
    }
    return callback;
  };

  // Ukuran viewport diamati supaya fit dan pemusatan memakai ukuran nyata.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const update = (): void => {
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit sekali per pemasangan, bukan tiap polling.
  useEffect(() => {
    if (fitDone.current) return;
    if (rects.length === 0) return;
    if (viewport.width <= 0 || viewport.height <= 0) return;
    fitDone.current = true;
    setView(fitView(rects, viewport));
  }, [rects, viewport]);

  // Muat HTML halaman untuk frame yang hidup; pertahankan hasil per slug.
  useEffect(() => {
    const bySlug = new Map(design.pages.map((page) => [page.slug, page]));
    for (const slug of live) {
      const page = bySlug.get(slug);
      if (page === undefined || page.missing) continue;
      const doc = docs[slug];
      if (doc !== undefined && doc.mtime === page.mtime) continue;
      if (loadingRef.current.has(slug)) continue;
      loadingRef.current.add(slug);
      void api
        .getDesignPage(sessionId, slug, repo)
        .then((result) => {
          setDocs((prev) => ({
            ...prev,
            [slug]: { html: result.html, mtime: result.mtime, warnings: result.warnings.length },
          }));
        })
        .catch(() => {
          // Gagal memuat satu halaman tidak menghentikan kanvas.
        })
        .finally(() => {
          loadingRef.current.delete(slug);
        });
    }
  }, [liveKey, design, api, sessionId, repo, docs]);

  // Buang override yang sudah sama dengan data server.
  useEffect(() => {
    setOverrides((prev) => {
      let changed = false;
      const next: Record<string, Override> = { ...prev };
      for (const [slug, override] of Object.entries(prev)) {
        const page = design.pages.find((item) => item.slug === slug);
        if (page === undefined) continue;
        const deviceSama = override.device === undefined || override.device === page.device;
        if (page.x === override.x && page.y === override.y && deviceSama) {
          delete next[slug];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [design]);

  // Pesan dari frame: satu pendengar untuk semua iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      let slug: string | undefined;
      let element: HTMLIFrameElement | undefined;
      for (const [key, el] of frameEls.current) {
        if (isFromFrame(event, el.contentWindow)) {
          slug = key;
          element = el;
          break;
        }
      }
      if (slug === undefined || element === undefined) return;
      const message = parseFrameMessage(event.data);
      if (message === undefined) return;
      switch (message.type) {
        case "ready":
          element.contentWindow?.postMessage(
            modeMessage(toolRef.current === "select" ? "select" : "preview"),
            "*",
          );
          return;
        case "size":
          setContentHeights((prev) =>
            prev[slug] === message.height ? prev : { ...prev, [slug]: message.height },
          );
          return;
        case "hover": {
          if (toolRef.current !== "select") return;
          lastHoverRef.current = { slug, label: message.label };
          setHover({
            slug,
            tag: message.tag,
            label: message.label,
            bounds: message.bounds,
          });
          return;
        }
        case "select": {
          if (toolRef.current !== "select") return;
          const page = pageBySlugRef.current.get(slug);
          const sebelumnya = selectionRef.current;
          if (sebelumnya !== undefined && sebelumnya.slug !== slug) {
            const frameLama = frameEls.current.get(sebelumnya.slug);
            frameLama?.contentWindow?.postMessage(clearSelectionMessage(), "*");
          }
          setHover(undefined);
          selectionMtimeRef.current = page?.mtime;
          const labelHover = lastHoverRef.current;
          setSelectionLabel(
            labelHover !== undefined && labelHover.slug === slug ? labelHover.label : message.tag,
          );
          setSelection({
            slug,
            title: page?.title ?? slug,
            selector: message.selector,
            tag: message.tag,
            text: message.text,
            html: message.html,
            bounds: message.bounds,
            style: message.style,
          });
          return;
        }
        case "wheel": {
          const rect = rectsRef.current.find((item) => item.slug === slug);
          if (rect === undefined) return;
          const action = wheelAction({
            ctrlKey: message.ctrlKey,
            metaKey: false,
            deltaX: message.deltaX,
            deltaY: message.deltaY,
            deltaMode: 0,
          });
          setView((current) => {
            if (action.kind === "zoom") {
              const anchor = worldToScreen(current, {
                x: rect.x + message.clientX,
                y: rect.y + message.clientY,
              });
              return zoomBy(current, action.factor, anchor);
            }
            return panBy(current, action.dx * current.zoom, action.dy * current.zoom);
          });
          return;
        }
        case "pan":
          setView((current) =>
            panBy(current, message.dx * current.zoom, message.dy * current.zoom),
          );
          return;
        default:
          // `route` belum ditangani di komit ini.
          return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Sebarkan mode alat ke semua frame hidup saat alat berganti atau frame
  // baru menjadi hidup; frame yang baru siap meminta ulang lewat `ready`.
  useEffect(() => {
    const pesan = modeMessage(tool === "select" ? "select" : "preview");
    for (const el of frameEls.current.values()) {
      el.contentWindow?.postMessage(pesan, "*");
    }
  }, [tool, liveKey]);

  // Ganti alat membuang hover; meninggalkan alat Pilih membuang pilihan.
  useEffect(() => {
    setHover(undefined);
    if (tool !== "select") setSelection(undefined);
  }, [tool]);

  // Pilihan dibuang saat halaman terpilih hilang dari desain atau HTML-nya
  // dimuat ulang (mtime berubah).
  const selectionSlug = selection?.slug;
  useEffect(() => {
    if (selectionSlug === undefined) return;
    const page = design.pages.find((item) => item.slug === selectionSlug);
    if (page === undefined || page.missing) {
      setSelection(undefined);
      return;
    }
    const doc = docs[selectionSlug];
    if (doc !== undefined && doc.mtime !== selectionMtimeRef.current) {
      setSelection(undefined);
    }
  }, [selectionSlug, design, docs]);

  // Roda mouse di wadah: zoom ke arah kursor atau geser.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const action = wheelAction(event);
      const box = el.getBoundingClientRect();
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top };
      setView((current) =>
        action.kind === "zoom"
          ? zoomBy(current, action.factor, anchor)
          : panBy(current, action.dx, action.dy),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    };
  }, []);

  const flush = async (): Promise<void> => {
    const entries = [...pendingRef.current.entries()].map(([slug, value]) => ({
      slug,
      x: value.x,
      y: value.y,
      ...(value.device === undefined ? {} : { device: value.device }),
    }));
    pendingRef.current.clear();
    if (entries.length === 0) return;
    try {
      await api.saveDesignLayout(sessionId, entries, repo);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
      setOverrides({});
    }
  };

  const scheduleSave = (slug: string, patch: Override): void => {
    const prev = pendingRef.current.get(slug);
    pendingRef.current.set(slug, { ...prev, ...patch });
    if (timerRef.current !== undefined) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  };

  const startPan = (event: PointerEvent): void => {
    panDrag.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const movePan = (event: PointerEvent): void => {
    const drag = panDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    setView((current) => panBy(current, dx, dy));
  };

  const endPan = (event: PointerEvent): void => {
    if (panDrag.current === null || panDrag.current.pointerId !== event.pointerId) return;
    panDrag.current = null;
    setDragging(false);
  };

  const onOverlayDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    containerRef.current?.focus();
    startPan(event);
  };

  const onContainerDown = (event: PointerEvent): void => {
    if (event.button === 1) {
      event.preventDefault();
      startPan(event);
      return;
    }
    // Fokus ke wadah agar pintasan aktif, kecuali pointer mengenai kontrol.
    const target = event.target;
    const interaktif =
      target instanceof Element &&
      target.closest("button, a, input, select, textarea, [role='menu']") !== null;
    if (!interaktif) containerRef.current?.focus();
    // Klik ruang kosong kanvas (di luar frame dan chrome) membuang pilihan.
    if (toolRef.current === "select" && target instanceof Element) {
      const diChrome = target.closest(
        ".jk-design-frame, .jk-design-frame-label, .jk-design-toolbar, .jk-design-pages, .jk-design-zoom, .jk-design-actions, .jk-design-info",
      );
      if (diChrome === null) setSelection(undefined);
    }
  };

  const onLabelDown = (slug: string, event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".jk-dd") !== null) return;
    const page = pageBySlug.get(slug);
    if (page === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    frameDrag.current = {
      slug,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: page.x,
      originY: page.y,
      x: page.x,
      y: page.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onLabelMove = (event: PointerEvent): void => {
    const drag = frameDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const zoom = viewRef.current.zoom;
    drag.x = drag.originX + (event.clientX - drag.startX) / zoom;
    drag.y = drag.originY + (event.clientY - drag.startY) / zoom;
    const { slug } = drag;
    const x = drag.x;
    const y = drag.y;
    setOverrides((prev) => {
      const base = prev[slug];
      return { ...prev, [slug]: { x, y, ...(base?.device === undefined ? {} : { device: base.device }) } };
    });
  };

  const onLabelUp = (event: PointerEvent): void => {
    const drag = frameDrag.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    frameDrag.current = null;
    setDragging(false);
    if (drag.x === drag.originX && drag.y === drag.originY) return;
    const x = snap(drag.x, 8);
    const y = snap(drag.y, 8);
    const device = overridesRef.current[drag.slug]?.device;
    setOverrides((prev) => ({
      ...prev,
      [drag.slug]: { x, y, ...(device === undefined ? {} : { device }) },
    }));
    scheduleSave(drag.slug, { x, y });
  };

  const onDevice = (slug: string, device: DeviceId): void => {
    const page = pageBySlug.get(slug);
    if (page === undefined) return;
    const override = overridesRef.current[slug];
    const x = override?.x ?? page.x;
    const y = override?.y ?? page.y;
    setOverrides((prev) => ({ ...prev, [slug]: { x, y, device } }));
    scheduleSave(slug, { x, y, device });
  };

  const reloadFrame = (slug: string): void => {
    if (selectionRef.current?.slug === slug) setSelection(undefined);
    setDocs((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });
  };

  const refreshAll = (): void => {
    setSelection(undefined);
    setDocs({});
    void refresh();
  };

  const zoomTo = (zoom: number): void => {
    const size = viewportRef.current;
    setView((current) => zoomAt(current, zoom, { x: size.width / 2, y: size.height / 2 }));
  };

  const step = (dir: 1 | -1): void => {
    const size = viewportRef.current;
    setView((current) =>
      zoomAt(current, stepZoom(current.zoom, dir), { x: size.width / 2, y: size.height / 2 }),
    );
  };

  const fit = (): void => {
    setView(fitView(rectsRef.current, viewportRef.current));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (targetKindOf(event.target) === "input") return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const interaktif =
      target instanceof Element &&
      target.closest("button, a, [role='menu'], [role='menuitem'], [role='menuitemradio']") !== null;
    // Jangan telan Space pada tombol dan Esc saat menu frame terbuka.
    if (interaktif && (event.key === " " || event.key === "Escape")) return;
    switch (event.key) {
      case "v":
      case "V":
        event.preventDefault();
        event.stopPropagation();
        setTool("select");
        return;
      case "h":
      case "H":
        event.preventDefault();
        event.stopPropagation();
        setTool("pan");
        return;
      case "p":
      case "P":
        event.preventDefault();
        event.stopPropagation();
        setTool("preview");
        return;
      case "0":
        event.preventDefault();
        event.stopPropagation();
        zoomTo(1);
        return;
      case "1":
        event.preventDefault();
        event.stopPropagation();
        fit();
        return;
      case "+":
      case "=":
        event.preventDefault();
        event.stopPropagation();
        step(1);
        return;
      case "-":
        event.preventDefault();
        event.stopPropagation();
        step(-1);
        return;
      case " ":
        event.preventDefault();
        event.stopPropagation();
        setSpaceHeld(true);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        if (selectionRef.current !== undefined) {
          setSelection(undefined);
          return;
        }
        onExit();
        return;
      default:
        return;
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === " ") setSpaceHeld(false);
  };

  const panMode = tool === "pan" || spaceHeld;
  const classes = [
    "jk-design-canvas",
    panMode ? "jk-design-pan" : "",
    dragging ? "jk-design-dragging" : "",
  ]
    .filter((item) => item !== "")
    .join(" ");

  const selectionRect =
    selection === undefined
      ? undefined
      : rects.find((item) => item.slug === selection.slug);
  const hoverRect = hover === undefined ? undefined : rects.find((item) => item.slug === hover.slug);
  const hoverSama =
    hover !== undefined &&
    selection !== undefined &&
    hover.slug === selection.slug &&
    hover.bounds.x === selection.bounds.x &&
    hover.bounds.y === selection.bounds.y &&
    hover.bounds.width === selection.bounds.width &&
    hover.bounds.height === selection.bounds.height;
  const border = overlayBorder(view.zoom);
  const selectionPage =
    selection === undefined ? undefined : pageBySlug.get(selection.slug);

  return (
    <section
      ref={containerRef}
      class={classes}
      tabIndex={0}
      role="application"
      aria-label="Kanvas desain"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPointerDown={onContainerDown}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div
        class="jk-design-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      >
        {panMode && (
          <div
            class="jk-design-overlay"
            style={{
              left: `${-view.x / view.zoom}px`,
              top: `${-view.y / view.zoom}px`,
              width: `${Math.max(1, viewport.width) / view.zoom}px`,
              height: `${Math.max(1, viewport.height) / view.zoom}px`,
            }}
            onPointerDown={onOverlayDown}
          />
        )}

        {rects.map((rect) => {
          const page = pageBySlug.get(rect.slug);
          if (page === undefined) return null;
          const doc = docs[rect.slug];
          return (
            <DesignFrame
              key={rect.slug}
              title={page.title}
              route={page.route}
              device={page.device}
              rect={rect as Rect}
              zoom={view.zoom}
              live={liveSet.has(rect.slug)}
              missing={page.missing}
              html={doc?.html}
              warnings={doc?.warnings ?? 0}
              onLabelPointerDown={(event) => onLabelDown(rect.slug, event)}
              onLabelPointerMove={onLabelMove}
              onLabelPointerUp={onLabelUp}
              onDevice={(device) => onDevice(rect.slug, device)}
              onReload={() => reloadFrame(rect.slug)}
              onPointerLeave={() => setHover(undefined)}
              setFrameRef={frameRefFor(rect.slug)}
            />
          );
        })}

        {hover !== undefined && hoverRect !== undefined && !hoverSama && (
          <div
            class="jk-design-overlay-hover"
            style={{
              left: `${overlayRect(hoverRect, hover.bounds).x}px`,
              top: `${overlayRect(hoverRect, hover.bounds).y}px`,
              width: `${hover.bounds.width}px`,
              height: `${hover.bounds.height}px`,
              borderWidth: `${border}px`,
            }}
          />
        )}

        {selection !== undefined && selectionRect !== undefined && (
          <>
            <div
              class="jk-design-overlay-select"
              style={{
                left: `${overlayRect(selectionRect, selection.bounds).x}px`,
                top: `${overlayRect(selectionRect, selection.bounds).y}px`,
                width: `${selection.bounds.width}px`,
                height: `${selection.bounds.height}px`,
                borderWidth: `${border}px`,
              }}
            />
            <div
              class="jk-design-chip"
              style={{
                left: `${overlayRect(selectionRect, selection.bounds).x}px`,
                top: `${overlayRect(selectionRect, selection.bounds).y}px`,
                transform: `scale(${1 / view.zoom}) translateY(-100%)`,
              }}
            >
              {chipText(selection.tag, selectionLabel === "" ? selection.tag : selectionLabel)}
            </div>
          </>
        )}
      </div>

      {design.pages.length === 0 && <div class="jk-design-empty">{EMPTY_TEXT}</div>}

      <div class="jk-design-toolbar" role="toolbar" aria-label="Alat kanvas">
        <button
          type="button"
          class="jk-design-tool"
          aria-pressed={tool === "select"}
          aria-label="Pilih elemen (V)"
          title="Pilih elemen (V)"
          onClick={() => setTool("select")}
        >
          Pilih
        </button>
        <button
          type="button"
          class="jk-design-tool"
          aria-pressed={tool === "pan"}
          aria-label="Geser (H)"
          title="Geser (H)"
          onClick={() => setTool("pan")}
        >
          Geser
        </button>
        <button
          type="button"
          class="jk-design-tool"
          aria-pressed={tool === "preview"}
          aria-label="Pratinjau (P)"
          title="Pratinjau (P)"
          onClick={() => setTool("preview")}
        >
          Pratinjau
        </button>
      </div>

      <div class="jk-design-pages">
        <button
          type="button"
          class="jk-design-chip"
          aria-haspopup="menu"
          aria-expanded={pagesOpen}
          aria-label="Daftar halaman"
          title="Daftar halaman"
          onClick={() => setPagesOpen((open) => !open)}
        >
          Halaman
        </button>
        {pagesOpen && (
          <ul class="jk-design-pages-menu" role="menu" aria-label="Daftar halaman">
            {pages.map((page) => (
              <li key={page.slug}>
                <button
                  type="button"
                  role="menuitem"
                  class="jk-design-pages-item"
                  onClick={() => {
                    const rect = rectsRef.current.find((item) => item.slug === page.slug);
                    if (rect !== undefined) {
                      setView((current) => centerOn(current, rect, viewportRef.current));
                    }
                    setPagesOpen(false);
                  }}
                >
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="jk-design-zoom" role="group" aria-label="Zoom kanvas">
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Perkecil"
          title="Perkecil"
          onClick={() => step(-1)}
        >
          −
        </button>
        <span class="jk-design-zoom-value">{Math.round(view.zoom * 100)}%</span>
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Perbesar"
          title="Perbesar"
          onClick={() => step(1)}
        >
          +
        </button>
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Zoom 100%"
          title="Zoom 100%"
          onClick={() => zoomTo(1)}
        >
          100%
        </button>
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Muat semua"
          title="Muat semua"
          onClick={fit}
        >
          Muat semua
        </button>
      </div>

      <div class="jk-design-actions">
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Segarkan"
          title="Segarkan"
          onClick={refreshAll}
        >
          Segarkan
        </button>
        <button
          type="button"
          class="jk-design-chip"
          aria-label="Keluar dari mode lebar"
          title="Keluar dari mode lebar"
          onClick={onExit}
        >
          Keluar dari mode lebar
        </button>
      </div>

      {selection !== undefined && (
        <aside class="jk-design-info" aria-label="Elemen terpilih">
          <div class="jk-design-info-head">
            <span class="jk-design-info-chip">
              {chipText(selection.tag, selectionLabel === "" ? selection.tag : selectionLabel)}
            </span>
            <button
              type="button"
              class="jk-design-chip"
              aria-expanded={infoOpen}
              aria-label={infoOpen ? "Lipat info elemen" : "Buka info elemen"}
              title={infoOpen ? "Lipat info elemen" : "Buka info elemen"}
              onClick={() => setInfoOpen((open) => !open)}
            >
              {infoOpen ? "Lipat" : "Buka"}
            </button>
          </div>
          {infoOpen && (
            <div class="jk-design-info-body">
              <p class="jk-design-info-title">{selectionPage?.title ?? selection.title}</p>
              <code class="jk-design-info-selector">{selection.selector}</code>
              {selection.text.trim() !== "" && (
                <p class="jk-design-info-text">{selection.text.slice(0, 200)}</p>
              )}
              <p class="jk-design-info-size">
                {Math.round(selection.bounds.width)} x {Math.round(selection.bounds.height)}
              </p>
              {styleRows(selection.style).length > 0 && (
                <dl class="jk-design-info-styles">
                  {styleRows(selection.style).map((row) => (
                    <div class="jk-design-info-row" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div class="jk-design-info-actions">
                <CopyButton text={selection.selector} label="Salin selector" />
                <CopyButton text={selection.html} label="Salin HTML" />
                <button
                  type="button"
                  class="jk-design-chip"
                  onClick={() =>
                    props.onQuote(elementContext(selection, pageFile(selection.slug)))
                  }
                >
                  Sisipkan ke pesan
                </button>
              </div>
            </div>
          )}
        </aside>
      )}

      <p class="jk-visually-hidden" aria-live="polite">
        {selection === undefined ? "" : `Elemen terpilih: ${selection.tag}`}
      </p>

      {error !== undefined && (
        <p class="jk-design-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
