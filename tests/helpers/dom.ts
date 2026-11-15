/**
 * DOM sangat minimal untuk menguji komponen Preact tanpa peramban.
 *
 * Repo tidak memakai pustaka DOM. Helper ini hanya menyediakan bagian yang
 * benar-benar dipakai Preact (elemen, atribut, gaya, peristiwa, dan
 * `getBoundingClientRect`) supaya komponen ber-hook seperti `Select` bisa
 * diuji tanpa peramban sungguhan.
 */

import { render, type ComponentChild } from "preact";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Nama peristiwa yang Preact cari lewat operator `in`. */
const EVENTS = new Set([
  "blur",
  "change",
  "click",
  "compositionend",
  "compositionstart",
  "contextmenu",
  "copy",
  "cut",
  "dblclick",
  "dragstart",
  "drop",
  "focus",
  "focusin",
  "focusout",
  "input",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseenter",
  "mouseleave",
  "mousemove",
  "mouseout",
  "mouseover",
  "mouseup",
  "paste",
  "pointerdown",
  "pointerenter",
  "pointerleave",
  "pointermove",
  "pointerup",
  "reset",
  "scroll",
  "submit",
  "touchend",
  "touchstart",
  "wheel",
]);

export interface FakeRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FakeEventInit {
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** Target peristiwa; Preact memasang pendengarnya di sini. */
export class FakeTarget {
  listeners: Map<string, ((event: unknown) => void)[]> = new Map();

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((item) => item !== fn),
    );
  }

  /** Jalankan seluruh pendengar untuk satu peristiwa. */
  emit(type: string, event: Record<string, unknown>): void {
    // Pendengar dipanggil dengan `this` = elemen, seperti di peramban.
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn.call(this, event);
  }
}

/** Node tiruan; teks memakai `nodeType` 3, elemen memakai 1. */
export class FakeNode extends FakeTarget {
  nodeType: number = 1;
  localName: string;
  namespaceURI: string;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  attributes: Map<string, string> = new Map();
  style: Record<string, unknown>;
  data = "";
  scrollHeight = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  /** Persegi elemen; bisa diubah per elemen. */
  rect: FakeRect = { top: 0, left: 0, right: 200, bottom: 32, width: 200, height: 32 };

  constructor(localName: string, namespaceURI: string = HTML_NS, nodeType = 1) {
    super();
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this.nodeType = nodeType;
    this.style = { cssText: "" };
    this.style.setProperty = (key: string, val: string): void => {
      this.style[key] = val;
    };
    this.style.removeProperty = (key: string): void => {
      delete this.style[key];
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name.toLowerCase());
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    const index = before === null ? -1 : this.childNodes.indexOf(before);
    child.parentNode = this;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  contains(node: FakeNode | null): boolean {
    if (node === null) return false;
    if (node === this) return true;
    return this.childNodes.some((child) => child.contains(node));
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  focus(): void {
    fakeDocument.activeElement = this;
  }

  blur(): void {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.data;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  /**
   * Luncurkan peristiwa pada elemen dan teruskan ke induknya.
   *
   * Peramban menjenkinskan peristiwa ke atas; Preact mengandalkan hal itu
   * untuk penangan di elemen induk (mis. menu `Select`).
   */
  override emit(type: string, event: Record<string, unknown>): void {
    // Tombol mati tidak menerima peristiwa tetikus, seperti di peramban.
    if (
      this.getAttribute("disabled") !== null &&
      (type === "click" || type === "mousedown" || type === "pointerdown")
    ) {
      return;
    }
    let node: FakeNode | null = this;
    while (node !== null) {
      const list = node.listeners.get(type);
      if (list !== undefined) {
        event["currentTarget"] = node;
        for (const fn of [...list]) fn.call(node, event);
      }
      node = node.parentNode;
    }
  }
}

export class FakeDocument extends FakeTarget {
  activeElement: FakeNode | null = null;
  documentElement = new FakeNode("html");

  createElement(tag: string): FakeNode {
    return asElement(new FakeNode(tag));
  }

  createElementNS(namespace: string, tag: string): FakeNode {
    return asElement(new FakeNode(tag, namespace));
  }

  createTextNode(text: string): FakeNode {
    const node = new FakeNode("#text", HTML_NS, 3);
    node.data = text;
    return node;
  }
}

export class FakeWindow extends FakeTarget {
  innerWidth = 1024;
  innerHeight = 768;
}

const fakeDocument = new FakeDocument();
const fakeWindow = new FakeWindow();

/**
 * Bungkus node dengan Proxy agar operator `in` mengenali nama peristiwa.
 *
 * Preact memakai `nama.toLowerCase() in dom` (mis. `"onclick" in dom`) untuk
 * menentukan nama peristiwa; tanpa ini, `onClick` akan dipasang sebagai
 * `Click` dan tak pernah terpanggil.
 */
export function asElement(node: FakeNode): FakeNode {
  return new Proxy(node, {
    has(target, key) {
      if (typeof key === "string") {
        const nama = key.startsWith("on") ? key.slice(2) : key;
        if (EVENTS.has(nama.toLowerCase())) return true;
      }
      return key in target;
    },
  }) as FakeNode;
}

/**
 * Pasang DOM tiruan ke `globalThis` dan kembalikan fungsi pembersih.
 *
 * Dipanggil sekali per berkas tes; dipasang ulang bila berkas lain sudah
 * mengganti global.
 */
export function installDom(): () => void {
  const globals = globalThis as Record<string, unknown>;
  const previousDocument = globals["document"];
  const previousWindow = globals["window"];
  globals["document"] = fakeDocument;
  globals["window"] = fakeWindow;
  return () => {
    globals["document"] = previousDocument;
    globals["window"] = previousWindow;
  };
}

/** Render vnode ke elemen akar tiruan. */
export function mount(vnode: ComponentChild): FakeNode {
  const root = asElement(new FakeNode("div"));
  render(vnode, root as unknown as HTMLElement);
  return root;
}

/** Semua elemen turunan yang cocok predikat (akar tak ikut diperiksa). */
export function findAll(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (node: FakeNode): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === 1) {
        if (predicate(child)) out.push(child);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** Elemen pertama yang cocok predikat. */
export function find(root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | undefined {
  return findAll(root, predicate)[0];
}

/** Elemen berdasarkan atribut, mis. `role="listbox"`. */
export function findByAttr(root: FakeNode, name: string, value: string): FakeNode | undefined {
  return find(root, (node) => node.getAttribute(name) === value);
}

/**
 * Luncurkan peristiwa pada elemen.
 *
 * Objek peristiwa dibuat manual: Preact meneruskan peristiwa mentah ke
 * penangan bila `options.event` tak disetel, jadi `currentTarget` dan `key`
 * harus diisi sendiri.
 */
export function fire(
  target: FakeNode,
  type: string,
  init: FakeEventInit = {},
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type,
    target,
    currentTarget: target,
    key: init.key ?? "",
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    defaultPrevented: false,
    preventDefault(): void {
      event["defaultPrevented"] = true;
    },
    stopPropagation(): void {},
  };
  target.emit(type, event);
  return event;
}

/** Luncurkan peristiwa pada dokumen (mis. klik di luar menu). */
export function fireDocument(type: string, init: FakeEventInit = {}): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type,
    target: fakeDocument.documentElement,
    currentTarget: fakeDocument,
    key: init.key ?? "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault(): void {},
    stopPropagation(): void {},
  };
  fakeDocument.emit(type, event);
  return event;
}

/**
 * Tunggu efek pasif (useEffect) Preact.
 *
 * Tanpa `requestAnimationFrame`, Preact menunda efek pasif lewat
 * `setTimeout`; jeda singkat sudah cukup untuk flushing-nya.
 */
export async function flushEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** Set ukuran viewport untuk perhitungan penempatan menu. */
export function setViewport(width: number, height: number): void {
  fakeWindow.innerWidth = width;
  fakeWindow.innerHeight = height;
}

/** Elemen yang sedang menerima fokus. */
export function activeElement(): FakeNode | null {
  return fakeDocument.activeElement;
}

export { fakeDocument, fakeWindow, HTML_NS, SVG_NS };
