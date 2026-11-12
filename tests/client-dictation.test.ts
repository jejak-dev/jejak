import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  createDictation,
  defaultLang,
  describeError,
  getRecognitionCtor,
  mergeTranscript,
  type DictationController,
  type RecognitionHost,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultListLike,
  type SpeechRecognitionResultLike,
} from "../src/client/lib/dictation";
import type { DictationState } from "../src/client/lib/use-dictation";
import { DictationButton } from "../src/client/components/DictationButton";

/* ---------- Bantuan: pengenal suara tiruan ---------- */

interface HasilPalsu {
  transcript: string;
  isFinal: boolean;
}

function buatDaftar(items: readonly HasilPalsu[]): SpeechRecognitionResultListLike {
  const list: SpeechRecognitionResultLike[] = items.map((item) => ({
    isFinal: item.isFinal,
    length: 1,
    0: { transcript: item.transcript },
  }));
  const indeks: Record<number, SpeechRecognitionResultLike> = {};
  list.forEach((item, index) => {
    indeks[index] = item;
  });
  return { length: list.length, ...indeks };
}

class PengenalPalsu implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  mulai = 0;
  berhenti = 0;
  batal = 0;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;

  start(): void {
    this.mulai += 1;
  }

  stop(): void {
    this.berhenti += 1;
  }

  abort(): void {
    this.batal += 1;
  }

  kirimHasil(items: readonly HasilPalsu[], resultIndex = 0): void {
    this.onresult?.({ resultIndex, results: buatDaftar(items) });
  }

  kirimGalat(error: string): void {
    this.onerror?.({ error });
  }

  kirimSelesai(): void {
    this.onend?.();
  }
}

function buatPengenal(): { ctor: SpeechRecognitionConstructor; terakhir: PengenalPalsu[] } {
  const terakhir: PengenalPalsu[] = [];
  class Turunan extends PengenalPalsu {
    constructor() {
      super();
      terakhir.push(this);
    }
  }
  return { ctor: Turunan as unknown as SpeechRecognitionConstructor, terakhir };
}

/* ---------- Bantuan: penelusuran pohon VNode tanpa DOM ---------- */

function cariVNode(
  node: ComponentChild,
  syarat: (vnode: VNode) => boolean,
): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => cariVNode(child, syarat));
  const vnode = node as VNode;
  const diri = syarat(vnode) ? [vnode] : [];
  return diri.concat(cariVNode(vnode.props.children as ComponentChild, syarat));
}

function propVNode(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function teksVNode(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(teksVNode).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "string") return teksVNode(vnode.props.children as ComponentChild);
  return "";
}

function statusPalsu(ubah: Partial<DictationState> = {}): DictationState {
  return {
    supported: true,
    active: false,
    askingConsent: false,
    consented: false,
    note: undefined,
    lang: "id-ID",
    disabled: false,
    toggle: () => undefined,
    acceptConsent: () => undefined,
    cancelConsent: () => undefined,
    changeLang: () => undefined,
    stop: () => undefined,
    abort: () => undefined,
    ...ubah,
  };
}

/* ---------- Tes ---------- */

describe("getRecognitionCtor", () => {
  test("mengembalikan SpeechRecognition bila ada", () => {
    class Pengenal extends PengenalPalsu {}
    const ctor = Pengenal as unknown as SpeechRecognitionConstructor;
    const host: RecognitionHost = { SpeechRecognition: ctor };
    expect(getRecognitionCtor(host)).toBe(ctor);
  });

  test("mengembalikan webkitSpeechRecognition untuk peramban lama", () => {
    class Pengenal extends PengenalPalsu {}
    const ctor = Pengenal as unknown as SpeechRecognitionConstructor;
    const host: RecognitionHost = { webkitSpeechRecognition: ctor };
    expect(getRecognitionCtor(host)).toBe(ctor);
  });

  test("membuatkan pemeriksa lebih dulu bila keduanya ada", () => {
    class Biasa extends PengenalPalsu {}
    class Prefiks extends PengenalPalsu {}
    const host: RecognitionHost = {
      SpeechRecognition: Biasa as unknown as SpeechRecognitionConstructor,
      webkitSpeechRecognition: Prefiks as unknown as SpeechRecognitionConstructor,
    };
    expect(getRecognitionCtor(host)).toBe(host.SpeechRecognition);
  });

  test("mengembalikan undefined bila peramban tidak mendukung", () => {
    expect(getRecognitionCtor({})).toBeUndefined();
    expect(getRecognitionCtor(null)).toBeUndefined();
    expect(getRecognitionCtor(undefined)).toBeUndefined();
  });
});

describe("defaultLang", () => {
  test("memakai bahasa peramban bila Indonesia", () => {
    expect(defaultLang("id-ID")).toBe("id-ID");
    expect(defaultLang("id")).toBe("id");
    expect(defaultLang("id-ID-x-jakarta")).toBe("id-ID-x-jakarta");
  });

  test("memakai id-ID untuk bahasa lain atau bahasa kosong", () => {
    expect(defaultLang("en-US")).toBe("id-ID");
    expect(defaultLang("en-GB")).toBe("id-ID");
    expect(defaultLang(undefined)).toBe("id-ID");
  });
});

describe("mergeTranscript", () => {
  test("draf kosong menerima teks final", () => {
    const hasil = mergeTranscript("", 0, "halo", "");
    expect(hasil.text).toBe("halo");
    expect(hasil.caret).toBe(4);
  });

  test("spasi akhir tidak jadi dua spasi", () => {
    const hasil = mergeTranscript("halo ", 5, "dunia", "");
    expect(hasil.text).toBe("halo dunia");
    expect(hasil.caret).toBe(10);
  });

  test("sisip di tengah draf tidak membuang teks setelahnya", () => {
    const hasil = mergeTranscript("halo dunia", 5, "hei", "");
    expect(hasil.text).toBe("halo hei dunia");
    expect(hasil.caret).toBe(8);
  });

  test("hasil sementara diganti hasil final tanpa menggandakan", () => {
    // Hasil sementara tidak pernah masuk draf terikat.
    const sementara = mergeTranscript("", 0, "", "halo");
    expect(sementara.text).toBe("halo");
    expect(sementara.caret).toBe(0);

    const final = mergeTranscript("", 0, "halo", "");
    expect(final.text).toBe("halo");
    expect(final.caret).toBe(4);
  });

  test("hasil sementara tampil setelah bagian final", () => {
    const hasil = mergeTranscript("", 0, "halo", "dunia");
    expect(hasil.text).toBe("halo dunia");
    expect(hasil.caret).toBe(4);
  });

  test("huruf besar-kecil tidak diubah", () => {
    const hasil = mergeTranscript("", 0, "Halo Dunia", "");
    expect(hasil.text).toBe("Halo Dunia");
  });

  test("karet di luar rentang draf dijepit", () => {
    expect(mergeTranscript("halo", 99, "dunia", "").text).toBe("halo dunia");
    expect(mergeTranscript("halo", -5, "dunia", "").text).toBe("dunia halo");
  });
});

describe("describeError", () => {
  test("izin mikrofon ditolak", () => {
    expect(describeError("not-allowed")).toBe("Izin mikrofon ditolak. Ubah di pengaturan situs.");
    expect(describeError("service-not-allowed")).toBe(
      "Izin mikrofon ditolak. Ubah di pengaturan situs.",
    );
  });

  test("tidak ada suara dan pembatalan dibiarkan diam", () => {
    expect(describeError("no-speech")).toBeUndefined();
    expect(describeError("aborted")).toBeUndefined();
  });

  test("jaringan dan mikrofon", () => {
    expect(describeError("network")).toBe("Layanan suara tidak terjangkau (perlu internet).");
    expect(describeError("audio-capture")).toBe("Mikrofon tidak ditemukan.");
  });

  test("galat lain memakai pesan umum", () => {
    expect(describeError("language-not-supported")).toBe(
      "Dikte berhenti karena kesalahan. Coba lagi.",
    );
    expect(describeError("apa saja")).toBe("Dikte berhenti karena kesalahan. Coba lagi.");
  });
});

describe("createDictation", () => {
  test("menyusun hasil final dan sementara dari peristiwa", () => {
    const { ctor, terakhir } = buatPengenal();
    const hasil: { final: string; interim: string }[] = [];
    createDictation({
      ctor,
      lang: "id-ID",
      onResult: (final, interim) => hasil.push({ final, interim }),
      onError: () => undefined,
      onEnd: () => undefined,
    });

    const pengenal = terakhir[0];
    expect(pengenal).toBeDefined();
    pengenal?.kirimHasil([{ transcript: "halo", isFinal: false }]);
    expect(hasil[0]).toEqual({ final: "", interim: "halo" });

    pengenal?.kirimHasil([{ transcript: "halo", isFinal: true }]);
    expect(hasil[1]).toEqual({ final: "halo", interim: "" });

    pengenal?.kirimHasil([
      { transcript: "halo", isFinal: true },
      { transcript: "dunia", isFinal: false },
    ], 1);
    expect(hasil[2]).toEqual({ final: "halo", interim: "dunia" });

    pengenal?.kirimHasil([
      { transcript: "halo", isFinal: true },
      { transcript: "dunia", isFinal: true },
    ], 1);
    expect(hasil[3]).toEqual({ final: "halo dunia", interim: "" });
  });

  test("mengatur continuous, interimResults, dan bahasa", () => {
    const { ctor, terakhir } = buatPengenal();
    createDictation({
      ctor,
      lang: "en-US",
      onResult: () => undefined,
      onError: () => undefined,
      onEnd: () => undefined,
    });
    const pengenal = terakhir[0];
    expect(pengenal?.continuous).toBe(true);
    expect(pengenal?.interimResults).toBe(true);
    expect(pengenal?.lang).toBe("en-US");
  });

  test("onEnd dipanggil saat pengenalan selesai", () => {
    const { ctor, terakhir } = buatPengenal();
    let selesai = 0;
    createDictation({
      ctor,
      lang: "id-ID",
      onResult: () => undefined,
      onError: () => undefined,
      onEnd: () => {
        selesai += 1;
      },
    });
    terakhir[0]?.kirimSelesai();
    expect(selesai).toBe(1);
  });

  test("stop dan abort memanggil metode yang sesuai", () => {
    const { ctor, terakhir } = buatPengenal();
    const kendali: DictationController = createDictation({
      ctor,
      lang: "id-ID",
      onResult: () => undefined,
      onError: () => undefined,
      onEnd: () => undefined,
    });
    kendali.start();
    kendali.stop();
    kendali.abort();
    const pengenal = terakhir[0];
    expect(pengenal?.mulai).toBe(1);
    expect(pengenal?.berhenti).toBe(1);
    expect(pengenal?.batal).toBe(1);
  });

  test("galat diteruskan ke pemanggil", () => {
    const { ctor, terakhir } = buatPengenal();
    const kode: string[] = [];
    createDictation({
      ctor,
      lang: "id-ID",
      onResult: () => undefined,
      onError: (code) => kode.push(code),
      onEnd: () => undefined,
    });
    terakhir[0]?.kirimGalat("not-allowed");
    expect(kode).toEqual(["not-allowed"]);
  });

  test("sesi yang berhenti sendiri tidak dinyalakan ulang", () => {
    const { ctor, terakhir } = buatPengenal();
    let selesai = 0;
    createDictation({
      ctor,
      lang: "id-ID",
      onResult: () => undefined,
      onError: () => undefined,
      onEnd: () => {
        selesai += 1;
      },
    });
    const pengenal = terakhir[0];
    pengenal?.kirimSelesai();
    pengenal?.kirimSelesai();
    expect(selesai).toBe(2);
    expect(pengenal?.mulai).toBe(0);
  });
});

describe("DictationButton", () => {
  test("tidak merender apa pun bila peramban tidak mendukung", () => {
    const hasil = DictationButton({ dict: statusPalsu({ supported: false }) });
    expect(hasil).toBeNull();
  });

  test("merender tombol mikrofon dengan aria-label yang benar", () => {
    const vnode = DictationButton({ dict: statusPalsu() }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    expect(tombol).toBeDefined();
    const prop = propVNode(tombol);
    expect(prop["aria-label"]).toBe("Mulai dikte");
    expect(prop["aria-pressed"]).toBe(false);
  });

  test("tombol aktif memakai aria-label Hentikan dikte dan titik berdenyut", () => {
    const vnode = DictationButton({ dict: statusPalsu({ active: true }) }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    expect(propVNode(tombol)["aria-label"]).toBe("Hentikan dikte");
    expect(propVNode(tombol)["aria-pressed"]).toBe(true);
    const titik = cariVNode(vnode, (n) => propVNode(n)["class"] === "jk-dictation-dot");
    expect(titik).toHaveLength(1);
  });

  test("kartu persetujuan muncul saat persetujuan belum ada", () => {
    const vnode = DictationButton({
      dict: statusPalsu({ askingConsent: true, consented: false }),
    }) as VNode;
    const kartu = cariVNode(vnode, (n) => propVNode(n)["class"] === "jk-dictation-consent");
    expect(kartu).toHaveLength(1);
    const teks = teksVNode(kartu[0]?.props.children as ComponentChild);
    expect(teks).toContain("Dikte memakai pengenal suara peramban Anda.");
    expect(teks).toContain("Jejak sendiri tidak menyimpan audio.");
    const tombol = cariVNode(kartu[0], (n) => n.type === "button");
    const label = tombol.map((n) => teksVNode(n.props.children as ComponentChild));
    expect(label).toContain("Mengerti, aktifkan");
    expect(label).toContain("Batal");
  });

  test("kartu persetujuan tidak muncul bila sudah disetujui", () => {
    const vnode = DictationButton({
      dict: statusPalsu({ askingConsent: true, consented: true }),
    }) as VNode;
    const kartu = cariVNode(vnode, (n) => propVNode(n)["class"] === "jk-dictation-consent");
    expect(kartu).toHaveLength(0);
  });

  test("pesan galat tampil sebagai baris jk-note", () => {
    const vnode = DictationButton({
      dict: statusPalsu({ note: "Mikrofon tidak ditemukan." }),
    }) as VNode;
    const catatan = cariVNode(vnode, (n) => propVNode(n)["class"] === "jk-note jk-dictation-note");
    expect(catatan).toHaveLength(1);
    expect(teksVNode(catatan[0]?.props.children as ComponentChild)).toBe(
      "Mikrofon tidak ditemukan.",
    );
  });

  test("tombol mati saat kolom mati", () => {
    const vnode = DictationButton({ dict: statusPalsu({ disabled: true }) }) as VNode;
    const tombol = cariVNode(vnode, (n) => n.type === "button")[0];
    expect(propVNode(tombol)["disabled"]).toBe(true);
  });
});
