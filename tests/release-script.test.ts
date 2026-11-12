import { expect, test } from "bun:test";
import {
  bumpChangelog,
  bumpPackageJson,
  compareSemver,
  hasUnreleasedContent,
  isValidSemver,
  unreleasedBody,
} from "../scripts/release";

const JUDUL_BELUM = "## [Belum dirilis]";

test("isValidSemver menerima versi yang sah", () => {
  expect(isValidSemver("0.0.1")).toBe(true);
  expect(isValidSemver("1.2.3")).toBe(true);
  expect(isValidSemver("1.0.0-beta.1")).toBe(true);
  expect(isValidSemver("1.0.0-beta.1+build.7")).toBe(true);
});

test("isValidSemver menolak versi yang rusak", () => {
  expect(isValidSemver("1.0")).toBe(false);
  expect(isValidSemver("1.0.0.0")).toBe(false);
  expect(isValidSemver("v1.0.0")).toBe(false);
  expect(isValidSemver("")).toBe(false);
  expect(isValidSemver("1.0.0-")).toBe(false);
});

test("compareSemver membandingkan inti numerik", () => {
  expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
  expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
  expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
  expect(compareSemver("2.0.0", "2.0.0")).toBe(0);
});

test("compareSemver menempatkan prarilis di bawah rilis yang sama", () => {
  expect(compareSemver("1.0.0-beta.1", "1.0.0")).toBe(-1);
  expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBe(1);
  expect(compareSemver("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
  expect(compareSemver("1.0.0-beta.10", "1.0.0-beta.9")).toBe(1);
});

test("compareSemver menolak input tidak valid", () => {
  expect(() => compareSemver("1.0", "1.0.0")).toThrow();
});

test("unreleasedBody menemukan isi bagian yang belum terbit", () => {
  const teks = ["# Changelog", "", JUDUL_BELUM, "", "- satu", "", "## [0.0.1]", ""].join(
    "\n",
  );
  const isi = unreleasedBody(teks);
  expect(isi).not.toBeNull();
  expect(isi?.join("\n")).toContain("- satu");
  expect(hasUnreleasedContent(teks)).toBe(true);
});

test("unreleasedBody mengembalikan null bila bagian belum terbit tidak ada", () => {
  const teks = ["# Changelog", "", "## [0.0.1]", "", "- satu"].join("\n");
  expect(unreleasedBody(teks)).toBeNull();
  expect(hasUnreleasedContent(teks)).toBe(false);
});

test("hasUnreleasedContent menolak bagian yang kosong", () => {
  const teks = ["# Changelog", "", JUDUL_BELUM, "", "## [0.0.1]", ""].join("\n");
  expect(hasUnreleasedContent(teks)).toBe(false);
});

test("bumpChangelog memindahkan isi ke bagian versi bertanggal", () => {
  const teks = [
    "# Changelog",
    "",
    JUDUL_BELUM,
    "",
    "### Ditambah",
    "",
    "- fitur satu",
    "",
    "## [0.0.1]",
    "",
  ].join("\n");
  const hasil = bumpChangelog(teks, "1.0.0", "2026-11-12");
  expect(hasil).toContain("## [1.0.0] - 2026-11-12");
  expect(hasil).toContain("- fitur satu");
  expect(hasil).toContain("## [0.0.1]");
  expect(hasil.indexOf(JUDUL_BELUM)).toBeLessThan(
    hasil.indexOf("## [1.0.0] - 2026-11-12"),
  );
});

test("bumpChangelog menyisipkan bagian belum terbit yang kosong", () => {
  const teks = [JUDUL_BELUM, "", "- fitur satu", "", "## [0.0.1]", ""].join("\n");
  const hasil = bumpChangelog(teks, "1.0.0", "2026-11-12");
  expect(hasUnreleasedContent(hasil)).toBe(false);
  expect(unreleasedBody(hasil)).toEqual([""]);
});

test("bumpChangelog gagal bila bagian belum terbit tidak ada", () => {
  const teks = ["# Changelog", "", "## [0.0.1]", "", "- satu"].join("\n");
  expect(() => bumpChangelog(teks, "1.0.0", "2026-11-12")).toThrow();
});

test("bumpChangelog gagal bila bagian belum terbit kosong", () => {
  const teks = [JUDUL_BELUM, "", "## [0.0.1]", ""].join("\n");
  expect(() => bumpChangelog(teks, "1.0.0", "2026-11-12")).toThrow();
});

test("bumpPackageJson mengganti versi dan menjaga indentasi", () => {
  const teks = '{\n  "name": "jejak",\n  "version": "0.0.1",\n  "private": true\n}\n';
  const hasil = bumpPackageJson(teks, "1.0.0");
  expect(hasil).toContain('"version": "1.0.0"');
  expect(hasil).toContain('  "name": "jejak"');
  expect(hasil.endsWith("}\n")).toBe(true);
  expect(hasil.endsWith("\n\n")).toBe(false);
});

test("bumpPackageJson menjaga urutan kunci dan isi lain", () => {
  const teks = '{\n  "name": "jejak",\n  "version": "0.0.1",\n  "files": [\n    "src/"\n  ]\n}\n';
  const hasil = bumpPackageJson(teks, "2.3.4");
  const data = JSON.parse(hasil) as Record<string, unknown>;
  expect(data.version).toBe("2.3.4");
  expect(data.name).toBe("jejak");
  expect(data.files).toEqual(["src/"]);
  expect(hasil.indexOf('"name"')).toBeLessThan(hasil.indexOf('"version"'));
});

test("bumpPackageJson menolak JSON rusak", () => {
  expect(() => bumpPackageJson("{ tidak valid", "1.0.0")).toThrow();
});
