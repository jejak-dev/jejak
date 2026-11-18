import { describe, expect, test } from "bun:test";
import {
  MAX_MEDIA,
  extractMedia,
  mediaFromToolInput,
  mediaKind,
  mediaUrl,
  toSessionRelative,
} from "../src/client/lib/media";

const CWD = "/tmp/proyek";

describe("mediaKind", () => {
  test("gambar dan video dikenali dari ekstensi", () => {
    expect(mediaKind("shot.png")).toBe("image");
    expect(mediaKind("foto.jpg")).toBe("image");
    expect(mediaKind("foto.jpeg")).toBe("image");
    expect(mediaKind("klip.webm")).toBe("video");
    expect(mediaKind("klip.mp4")).toBe("video");
    expect(mediaKind("klip.mov")).toBe("video");
  });

  test("svg dan txt bukan media", () => {
    expect(mediaKind("logo.svg")).toBeUndefined();
    expect(mediaKind("catatan.txt")).toBeUndefined();
  });

  test("huruf besar tetap dikenali", () => {
    expect(mediaKind("SHOT.PNG")).toBe("image");
    expect(mediaKind("KLIP.MP4")).toBe("video");
  });
});

describe("toSessionRelative", () => {
  test("path absolut di dalam cwd jadi relatif", () => {
    expect(toSessionRelative(CWD, "/tmp/proyek/shot.png")).toBe("shot.png");
    expect(toSessionRelative(CWD, "/tmp/proyek/sub/shot.png")).toBe("sub/shot.png");
  });

  test("path relatif diteruskan", () => {
    expect(toSessionRelative(CWD, "shot.png")).toBe("shot.png");
    expect(toSessionRelative(CWD, "./sub/shot.png")).toBe("sub/shot.png");
  });

  test("di luar cwd dan path ber-.. ditolak", () => {
    expect(toSessionRelative(CWD, "/tmp/lain/shot.png")).toBeUndefined();
    expect(toSessionRelative(CWD, "../shot.png")).toBeUndefined();
    expect(toSessionRelative(CWD, "sub/../../shot.png")).toBeUndefined();
  });

  test("URL berskema ditolak", () => {
    expect(toSessionRelative(CWD, "http://x/a.png")).toBeUndefined();
    expect(toSessionRelative(CWD, "data:image/png;base64,AAAA")).toBeUndefined();
    expect(toSessionRelative(CWD, "file:///tmp/proyek/a.png")).toBeUndefined();
  });

  test("path Windows dibandingkan tanpa peduli huruf besar", () => {
    expect(toSessionRelative("c:\\dev\\app", "C:\\Dev\\app\\shot.png")).toBe("shot.png");
  });
});

describe("mediaUrl", () => {
  test("path ber-spasi ter-encode", () => {
    expect(mediaUrl("s1", "shot satu.png")).toBe(
      "/api/sessions/s1/media?path=shot%20satu.png",
    );
  });
});

describe("extractMedia", () => {
  test("gambar markdown, tautan markdown, backtick, dan path polos", () => {
    const teks = [
      "Hasil: ![tangkapan](/tmp/proyek/shot.png)",
      "Video [klip](/tmp/proyek/klip.mp4)",
      "Berkas `/tmp/proyek/lain.jpg`",
      "Polos /tmp/proyek/polos.webm",
    ].join("\n");
    const hasil = extractMedia(teks, CWD);
    expect(hasil.map((item) => item.rel)).toEqual([
      "shot.png",
      "klip.mp4",
      "lain.jpg",
      "polos.webm",
    ]);
    expect(hasil.map((item) => item.kind)).toEqual(["image", "video", "image", "video"]);
    expect(hasil[0]?.name).toBe("shot.png");
  });

  test("duplikat dibuang, urut kemunculan", () => {
    const teks = "![a](/tmp/proyek/shot.png) lalu `/tmp/proyek/shot.png` dan /tmp/proyek/b.png";
    const hasil = extractMedia(teks, CWD);
    expect(hasil.map((item) => item.rel)).toEqual(["shot.png", "b.png"]);
  });

  test("dibatasi MAX_MEDIA", () => {
    const teks = Array.from({ length: MAX_MEDIA + 3 }, (_, i) => `/tmp/proyek/m${i}.png`).join(" ");
    expect(extractMedia(teks, CWD)).toHaveLength(MAX_MEDIA);
  });

  test("blok kode berpagar diabaikan", () => {
    const teks = "```\n/tmp/proyek/di-dalam.png\n```\n/tmp/proyek/di-luar.png";
    expect(extractMedia(teks, CWD).map((item) => item.rel)).toEqual(["di-luar.png"]);
  });

  test("URL http diabaikan", () => {
    const teks = "![x](https://situs.lain/a.png) dan http://situs.lain/b.mp4";
    expect(extractMedia(teks, CWD)).toEqual([]);
  });
});

describe("mediaFromToolInput", () => {
  test("Read berkas media menghasilkan rujukan", () => {
    expect(mediaFromToolInput(CWD, "Read", { file_path: "/tmp/proyek/shot.png" })).toEqual({
      rel: "shot.png",
      kind: "image",
      name: "shot.png",
    });
  });

  test("tool lain atau berkas non-media tidak menghasilkan rujukan", () => {
    expect(mediaFromToolInput(CWD, "Write", { file_path: "/tmp/proyek/shot.png" })).toBeUndefined();
    expect(mediaFromToolInput(CWD, "Read", { file_path: "/tmp/proyek/catatan.txt" })).toBeUndefined();
    expect(mediaFromToolInput(CWD, "Read", {})).toBeUndefined();
  });
});
