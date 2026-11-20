import { describe, expect, test } from "bun:test";
import { DesignError } from "../src/server/design/assemble";
import { validateScene } from "../src/server/design/scene";

const kotak = { kind: "box", name: "body", x: 0, y: 0, width: 10, height: 10 };
const halaman = (root: unknown = kotak) => ({ name: "Beranda", width: 100, height: 100, root });
const scene = (pages: unknown[] = [halaman()]) => ({ name: "Uji", pages });

function galat(value: unknown): string {
  try {
    validateScene(value);
  } catch (error) {
    expect(error).toBeInstanceOf(DesignError);
    expect((error as DesignError).status).toBe(400);
    return (error as DesignError).message;
  }
  return "";
}

describe("validateScene", () => {
  test("menerima scene sah dengan bidang opsional dan menjepit warna", () => {
    const hasil = validateScene(
      scene([
        halaman({
          ...kotak,
          fill: { r: 2, g: -1, b: 0.5, a: 1 },
          stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2 },
          radius: [1, 2, 3, 4],
          opacity: 0.5,
          clip: true,
          children: [
            {
              kind: "text",
              name: "t",
              x: 0,
              y: 0,
              width: 5,
              height: 5,
              text: {
                characters: "",
                fontSize: 12,
                fontFamily: "Inter",
                fontWeight: 400,
                italic: false,
                color: { r: 0, g: 0, b: 0, a: 1 },
                align: "left",
              },
            },
          ],
        }),
      ]),
    );
    expect(hasil.pages[0]?.root.fill).toEqual({ r: 1, g: 0, b: 0.5, a: 1 });
    expect(hasil.pages[0]?.root.children?.[0]?.text?.characters).toBe("");
  });

  test("menolak node teks tanpa text", () => {
    expect(galat(scene([halaman({ ...kotak, kind: "text" })]))).toContain("text wajib");
  });

  test("menolak bilangan tak terbatas", () => {
    expect(galat(scene([halaman({ ...kotak, x: Number.NaN })]))).toContain("bilangan terbatas");
    expect(galat(scene([halaman({ ...kotak, width: 1e9 })]))).toContain("bilangan terbatas");
  });

  test("menolak halaman kosong dan nama bukan teks", () => {
    expect(galat(scene([]))).toContain("minimal");
    expect(galat(scene([halaman({ ...kotak, name: 5 })]))).toContain("name harus berupa teks");
  });

  test("menolak kedalaman berlebih dan node terlalu banyak", () => {
    let dalam: Record<string, unknown> = { ...kotak };
    for (let i = 0; i < 70; i += 1) dalam = { ...kotak, children: [dalam] };
    expect(galat(scene([halaman(dalam)]))).toContain("terlalu dalam");
    const banyak = {
      ...kotak,
      children: Array.from({ length: 20001 }, () => ({ ...kotak })),
    };
    expect(galat(scene([halaman(banyak)]))).toContain("Terlalu banyak node");
  });

  test("menerima bayangan dan gambar, menolak yang cacat", () => {
    const sh = { x: 0, y: 2, blur: 8, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.1 }, inset: false };
    const ok = validateScene(
      scene([halaman({ ...kotak, shadows: [sh], image: { data: "QUJD", fit: "fill" } })]),
    );
    expect(ok.pages[0]?.root.shadows?.length).toBe(1);
    expect(ok.pages[0]?.root.image?.fit).toBe("fill");
    expect(galat(scene([halaman({ ...kotak, shadows: [{ ...sh, inset: "ya" }] })]))).toContain("inset");
    expect(galat(scene([halaman({ ...kotak, image: { data: "bukan base64!", fit: "fill" } })]))).toContain("base64");
    expect(galat(scene([halaman({ ...kotak, image: { data: "QUJD", fit: "zoom" } })]))).toContain("fit");
    const banyak = {
      ...kotak,
      children: Array.from({ length: 61 }, () => ({ ...kotak, image: { data: "QUJD", fit: "fill" } })),
    };
    expect(galat(scene([halaman(banyak)]))).toContain("Terlalu banyak gambar");
  });

  test("singleLine pada teks harus boolean", () => {
    const teks = (singleLine: unknown) =>
      scene([
        halaman({
          kind: "text", name: "t", x: 0, y: 0, width: 10, height: 10,
          text: { characters: "a", fontSize: 12, fontFamily: "Inter", fontWeight: 400, italic: false,
            color: { r: 0, g: 0, b: 0, a: 1 }, align: "left", singleLine },
        }),
      ]);
    expect(validateScene(teks(true)).pages[0]?.root.text?.singleLine).toBe(true);
    expect(galat(teks("ya"))).toContain("singleLine");
  });
});
