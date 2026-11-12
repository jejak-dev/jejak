/**
 * Skrip rilis Jejak: memvalidasi versi, menjalankan gerbang mutu, lalu menaikkan
 * versi di package.json dan CHANGELOG, membuat commit, dan menandai tag.
 *
 * Skrip ini tidak pernah mendorong ke remote (tidak ada `git push`).
 * Fungsi murni diekspor supaya bisa diuji tanpa menyentuh git.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Judul bagian CHANGELOG untuk rilis yang belum terbit. */
const UNRELEASED_HEADING = "## [Belum dirilis]";

/** Pola semver resmi: inti numerik, prarilis opsional, build metadata opsional. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Akar repo, dihitung dari lokasi skrip ini. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface SemverParts {
  core: [number, number, number];
  prerelease: string[] | null;
}

/** Menguraikan versi semver; mengembalikan null bila tidak valid. */
export function parseSemver(version: string): SemverParts | null {
  const cocok = SEMVER_PATTERN.exec(version);
  if (!cocok) return null;
  const core: [number, number, number] = [
    Number(cocok[1]),
    Number(cocok[2]),
    Number(cocok[3]),
  ];
  const prerelease = cocok[4] ? cocok[4].split(".") : null;
  return { core, prerelease };
}

/** True bila string versi mengikuti semver. */
export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/** Membandingkan dua bagian prarilis sesuai aturan semver. */
function comparePrerelease(a: string[], b: string[]): number {
  const panjang = Math.min(a.length, b.length);
  for (let i = 0; i < panjang; i++) {
    const kiri = a[i]!;
    const kanan = b[i]!;
    const kiriAngka = /^\d+$/.test(kiri);
    const kananAngka = /^\d+$/.test(kanan);
    if (kiriAngka && kananAngka) {
      const selisih = Number(kiri) - Number(kanan);
      if (selisih !== 0) return selisih < 0 ? -1 : 1;
    } else if (kiriAngka !== kananAngka) {
      return kiriAngka ? -1 : 1;
    } else if (kiri !== kanan) {
      return kiri < kanan ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Membandingkan dua versi semver.
 * Mengembalikan -1 bila a lebih kecil, 0 bila sama, 1 bila a lebih besar.
 * Prarilis selalu lebih kecil daripada rilis dengan inti yang sama.
 */
export function compareSemver(a: string, b: string): number {
  const kiri = parseSemver(a);
  const kanan = parseSemver(b);
  if (!kiri || !kanan) {
    throw new Error("versi tidak valid untuk dibandingkan");
  }
  for (let i = 0; i < 3; i++) {
    if (kiri.core[i]! !== kanan.core[i]!) {
      return kiri.core[i]! < kanan.core[i]! ? -1 : 1;
    }
  }
  if (!kiri.prerelease && !kanan.prerelease) return 0;
  if (!kiri.prerelease) return 1;
  if (!kanan.prerelease) return -1;
  return comparePrerelease(kiri.prerelease, kanan.prerelease);
}

/**
 * Baris isi bagian CHANGELOG di bawah judul yang belum terbit.
 * Mengembalikan null bila bagian itu tidak ada.
 */
export function unreleasedBody(text: string): string[] | null {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (index === -1) return null;
  let akhir = index + 1;
  while (akhir < lines.length && !lines[akhir]!.startsWith("## ")) akhir++;
  return lines.slice(index + 1, akhir);
}

/** True bila CHANGELOG punya bagian belum terbit yang isinya tidak kosong. */
export function hasUnreleasedContent(text: string): boolean {
  const body = unreleasedBody(text);
  if (body === null) return false;
  return body.some((line) => line.trim() !== "");
}

/**
 * Mengganti bagian belum terbit menjadi bagian rilis versi baru bertanggal,
 * lalu menyisipkan bagian belum terbit yang kosong di atasnya.
 */
export function bumpChangelog(text: string, version: string, date: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (index === -1) {
    throw new Error(`CHANGELOG tidak punya bagian ${UNRELEASED_HEADING}`);
  }
  let akhir = index + 1;
  while (akhir < lines.length && !lines[akhir]!.startsWith("## ")) akhir++;
  const isi = lines.slice(index + 1, akhir);
  if (!isi.some((line) => line.trim() !== "")) {
    throw new Error(`bagian ${UNRELEASED_HEADING} kosong, tidak ada yang bisa dirilis`);
  }
  const badan = isi.slice();
  while (badan.length > 0 && badan[0]!.trim() === "") badan.shift();
  while (badan.length > 0 && badan[badan.length - 1]!.trim() === "") badan.pop();
  return [
    ...lines.slice(0, index),
    UNRELEASED_HEADING,
    "",
    `## [${version}] - ${date}`,
    "",
    ...badan,
    "",
    ...lines.slice(akhir),
  ].join("\n");
}

/**
 * Menaikkan versi di package.json sambil menjaga indentasi dan newline akhir.
 */
export function bumpPackageJson(text: string, version: string): string {
  const data = JSON.parse(text) as Record<string, unknown>;
  data.version = version;
  const indentasi = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  return `${JSON.stringify(data, null, indentasi)}\n`;
}

interface HasilPerintah {
  code: number;
  stdout: string;
  stderr: string;
}

/** Menjalankan perintah di akar repo dan mengembalikan kode keluar serta keluarannya. */
function jalankan(command: string, args: string[]): HasilPerintah {
  const hasil = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  return {
    code: hasil.status ?? 1,
    stdout: hasil.stdout ?? "",
    stderr: hasil.stderr ?? "",
  };
}

/** Menjalankan alur rilis; mengembalikan kode keluar untuk skrip. */
export async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const posisi = argv.filter((argumen) => argumen !== "--dry-run");
  const version = posisi[0];

  if (!version) {
    console.error("Pakai: bun run scripts/release.ts <versi> [--dry-run]");
    return 1;
  }
  if (!isValidSemver(version)) {
    console.error(`Versi tidak valid: ${version}`);
    return 1;
  }

  const pathPackage = join(ROOT, "package.json");
  const pathChangelog = join(ROOT, "CHANGELOG.md");
  const teksPackage = readFileSync(pathPackage, "utf8");
  const versiSekarang = (JSON.parse(teksPackage) as { version?: string }).version;
  if (typeof versiSekarang !== "string") {
    console.error("package.json tidak punya field version");
    return 1;
  }
  if (compareSemver(version, versiSekarang) <= 0) {
    console.error(`Versi baru harus lebih besar dari versi sekarang (${versiSekarang})`);
    return 1;
  }

  const status = jalankan("git", ["status", "--porcelain"]);
  if (status.code !== 0) {
    console.error("Gagal memeriksa status git.");
    return 1;
  }
  if (status.stdout.trim() !== "") {
    console.error("Pohon kerja git tidak bersih. Commit atau stash dulu.");
    return 1;
  }

  const cabang = jalankan("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (cabang.code !== 0 || cabang.stdout.trim() !== "main") {
    console.error(`Rilis hanya boleh dari cabang main (sekarang: ${cabang.stdout.trim()}).`);
    return 1;
  }

  const tipe = jalankan("bun", ["run", "typecheck"]);
  if (tipe.code !== 0) {
    console.error("Pemeriksaan tipe gagal.");
    return 1;
  }

  const tes = jalankan("bun", ["test"]);
  if (tes.code !== 0) {
    console.error("Tes gagal.");
    return 1;
  }

  const teksChangelog = readFileSync(pathChangelog, "utf8");
  if (!hasUnreleasedContent(teksChangelog)) {
    console.error(`CHANGELOG tidak punya bagian ${UNRELEASED_HEADING} yang berisi.`);
    return 1;
  }

  const tanggal = new Date().toISOString().slice(0, 10);
  if (dryRun) {
    console.log(`Akan rilis ${version} (dari ${versiSekarang}) pada ${tanggal}.`);
    console.log(`Akan menulis versi ${version} ke package.json.`);
    console.log(
      `Akan mengganti bagian ${UNRELEASED_HEADING} dengan bagian ${version} di CHANGELOG.md.`,
    );
    console.log(`Akan membuat commit "chore: rilis ${version}".`);
    console.log(`Akan membuat tag anotasi v${version}.`);
    console.log("Tidak ada perubahan yang ditulis dan tidak ada push.");
    return 0;
  }

  writeFileSync(pathPackage, bumpPackageJson(teksPackage, version));
  writeFileSync(pathChangelog, bumpChangelog(teksChangelog, version, tanggal));

  const commit = jalankan("git", ["commit", "-am", `chore: rilis ${version}`]);
  if (commit.code !== 0) {
    console.error("Gagal membuat commit rilis.");
    return 1;
  }

  const tag = jalankan("git", ["tag", "-a", `v${version}`, "-m", `chore: rilis ${version}`]);
  if (tag.code !== 0) {
    console.error("Gagal membuat tag rilis.");
    return 1;
  }

  console.log(`Rilis ${version} siap. Commit dan tag v${version} dibuat.`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
