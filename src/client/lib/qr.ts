/**
 * Penulis kode QR Model 2 (ISO/IEC 18004) tanpa dependensi luar.
 *
 * Cakupan: mode byte (UTF-8), tingkat koreksi galat M, versi 1 sampai 10.
 * Modul gelap ditulis sebagai `true`; matriks memakai indeks [baris][kolom]
 * dan belum memakai quiet zone (jarak putih tepi).
 *
 * Rujukan algoritma: spesifikasi ISO/IEC 18004 dan implementasi "QR Code
 * generator" dari Project Nayuki (publik), ditulis ulang di sini.
 */

/** Indikator mode byte (0100). */
const MODE_BYTE = 0b0100;
/** Bits format tingkat koreksi galat M. */
const FORMAT_LEVEL_M = 0b00;
/** Polinom generator BCH untuk info format (15,5). */
const FORMAT_GENERATOR = 0x537;
/** Masker XOR info format. */
const FORMAT_XOR = 0x5412;
/** Polinom generator BCH untuk info versi (18,6). */
const VERSION_GENERATOR = 0x1f25;
/** Polinom primitif GF(256) untuk Reed-Solomon. */
const GF_PRIMITIVE = 0x11d;

/** Kode koreksi galat per blok, tingkat M, versi 1..10. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] as const;

/** Jumlah blok koreksi galat, tingkat M, versi 1..10. */
const BLOCK_COUNT = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] as const;

/** Posisi pola penyelarasan, versi 1..10 (versi 1 tak punya pola). */
const ALIGNMENT_POSITIONS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Jumlah modul per sisi untuk sebuah versi. */
export function qrSize(version: number): number {
  return 17 + 4 * version;
}

/** Perkalian di GF(256) dengan polinom primitif 0x11D. */
function gfMultiply(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * GF_PRIMITIVE);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

/**
 * Perkalian polinom di GF(256). Indeks 0 adalah koefisien derajat tertinggi.
 */
function polyMultiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = (out[i + j] ?? 0) ^ gfMultiply(a[i] ?? 0, b[j] ?? 0);
    }
  }
  return out;
}

/**
 * Polinom pembagi Reed-Solomon: ∏(x - α^i) untuk i = 0..eccLength-1.
 * Koefisien berurutan dari derajat tertinggi; koefisien terdegradasi (1)
 * dibuang sehingga panjangnya sama dengan `eccLength`.
 */
export function reedSolomonDivisor(eccLength: number): number[] {
  let poly: number[] = [1];
  let root = 1;
  for (let i = 0; i < eccLength; i++) {
    poly = polyMultiply(poly, [1, root]);
    root = gfMultiply(root, 2);
  }
  return poly.slice(1);
}

/**
 * Sisa pembagian data oleh polinom pembagi: inilah kode koreksi galat sebuah
 * blok (dikenal sebagai sisa Reed-Solomon).
 */
export function reedSolomonRemainder(
  data: readonly number[],
  eccLength: number,
): number[] {
  const divisor = reedSolomonDivisor(eccLength);
  const result = new Array<number>(eccLength).fill(0);
  for (const byte of data) {
    const factor = (byte ^ (result[0] ?? 0)) & 0xff;
    result.shift();
    result.push(0);
    for (let i = 0; i < eccLength; i++) {
      result[i] = (result[i] ?? 0) ^ gfMultiply(divisor[i] ?? 0, factor);
    }
  }
  return result;
}

/**
 * Sisa pembagian codeword (data + koreksi galat) oleh polinom pembagi.
 * Untuk codeword yang sah, semua nilainya nol.
 */
export function reedSolomonDivide(
  codeword: readonly number[],
  eccLength: number,
): number[] {
  const divisor = [1, ...reedSolomonDivisor(eccLength)];
  const work = codeword.slice();
  for (let i = 0; i + eccLength < work.length; i++) {
    const factor = work[i] ?? 0;
    if (factor === 0) continue;
    for (let j = 0; j < divisor.length; j++) {
      work[i + j] = (work[i + j] ?? 0) ^ gfMultiply(divisor[j] ?? 0, factor);
    }
  }
  return work.slice(work.length - eccLength);
}

/** Jumlah modul data mentah (termasuk bit sisa) untuk sebuah versi. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Jumlah codeword data untuk versi dan tingkat koreksi M. */
function dataCodewordCount(version: number): number {
  const total = Math.floor(rawDataModules(version) / 8);
  const ecc = ECC_PER_BLOCK[version - 1] ?? 0;
  const blocks = BLOCK_COUNT[version - 1] ?? 0;
  return total - ecc * blocks;
}

/** Pilih versi terkecil yang memuat seluruh masukan pada tingkat M. */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 10; version++) {
    const countBits = version <= 9 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    if (needed <= dataCodewordCount(version) * 8) return version;
  }
  throw new Error("Teks terlalu panjang untuk kode QR.");
}

/**
 * Susun codeword data: indikator mode, panjang karakter, isi UTF-8,
 * terminator, dan byte bantalan 0xEC/0x11.
 */
function buildDataCodewords(text: string, version: number): number[] {
  const bytes = new TextEncoder().encode(text);
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(MODE_BYTE, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacity = dataCodewordCount(version) * 8;
  const terminator = Math.min(4, capacity - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < dataCodewordCount(version); i++) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }
  return codewords;
}

/**
 * Bagi codeword data menjadi blok, hitung kode koreksi galat tiap blok, lalu
 * interleave data dan ECC sesuai standar.
 */
function interleaveBlocks(
  codewords: readonly number[],
  version: number,
): number[] {
  const blockCount = BLOCK_COUNT[version - 1] ?? 1;
  const eccLength = ECC_PER_BLOCK[version - 1] ?? 0;
  const total = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const data = codewords.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(data);
    eccBlocks.push(reedSolomonRemainder(data, eccLength));
  }

  const result: number[] = [];
  const maxData = dataBlocks.reduce((max, block) => Math.max(max, block.length), 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) result.push(block[i] ?? 0);
    }
  }
  for (let i = 0; i < eccLength; i++) {
    for (const block of eccBlocks) result.push(block[i] ?? 0);
  }
  return result;
}

/** Kanvas modul: nilai modul dan penanda modul fungsi (tak dimask). */
interface QrCanvas {
  modules: boolean[][];
  reserved: boolean[][];
}

function createCanvas(size: number): QrCanvas {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(
  canvas: QrCanvas,
  row: number,
  col: number,
  dark: boolean,
): void {
  const modules = canvas.modules[row];
  const reserved = canvas.reserved[row];
  if (modules === undefined || reserved === undefined) return;
  modules[col] = dark;
  reserved[col] = true;
}

/** Bit ke-`index` dari nilai yang sudah dimasker (bit 0 = terendah). */
function bitOf(value: number, index: number): boolean {
  return ((value >>> index) & 1) === 1;
}

/** Pola pencari 7x7 beserta pemisahnya. */
function drawFinderPattern(
  canvas: QrCanvas,
  centerCol: number,
  centerRow: number,
): void {
  const size = canvas.modules.length;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const col = centerCol + dx;
      const row = centerRow + dy;
      if (col < 0 || row < 0 || col >= size || row >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(canvas, row, col, dist !== 2 && dist !== 4);
    }
  }
}

/** Pola penyelarasan 5x5. */
function drawAlignmentPattern(
  canvas: QrCanvas,
  centerCol: number,
  centerRow: number,
): void {
  const size = canvas.modules.length;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const col = centerCol + dx;
      const row = centerRow + dy;
      if (col < 0 || row < 0 || col >= size || row >= size) continue;
      setFunction(canvas, row, col, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** Tulis info format (15 bit) ke dua salinan dan modul gelap tetap. */
function drawFormatBits(canvas: QrCanvas, mask: number): void {
  const size = canvas.modules.length;
  const data = (FORMAT_LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >>> 9) * FORMAT_GENERATOR);
  }
  const bits = ((data << 10) | rem) ^ FORMAT_XOR;

  for (let i = 0; i <= 5; i++) setFunction(canvas, i, 8, bitOf(bits, i));
  setFunction(canvas, 7, 8, bitOf(bits, 6));
  setFunction(canvas, 8, 8, bitOf(bits, 7));
  setFunction(canvas, 8, 7, bitOf(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(canvas, 8, 14 - i, bitOf(bits, i));

  for (let i = 0; i < 8; i++) setFunction(canvas, 8, size - 1 - i, bitOf(bits, i));
  for (let i = 8; i < 15; i++) {
    setFunction(canvas, size - 15 + i, 8, bitOf(bits, i));
  }
  setFunction(canvas, size - 8, 8, true);
}

/** Tulis info versi (18 bit) untuk versi 7 ke atas. */
function drawVersionBits(canvas: QrCanvas, version: number): void {
  if (version < 7) return;
  const size = canvas.modules.length;
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * VERSION_GENERATOR);
  }
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = bitOf(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(canvas, b, a, dark);
    setFunction(canvas, a, b, dark);
  }
}

/** Gambar semua pola fungsi: timing, pencari, penyelarasan, format, versi. */
function drawFunctionPatterns(canvas: QrCanvas, version: number): void {
  const size = canvas.modules.length;
  for (let i = 0; i < size; i++) {
    setFunction(canvas, 6, i, i % 2 === 0);
    setFunction(canvas, i, 6, i % 2 === 0);
  }

  drawFinderPattern(canvas, 3, 3);
  drawFinderPattern(canvas, size - 4, 3);
  drawFinderPattern(canvas, 3, size - 4);

  const positions = ALIGNMENT_POSITIONS[version - 1] ?? [];
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0);
      if (corner) continue;
      drawAlignmentPattern(canvas, positions[j] ?? 0, positions[i] ?? 0);
    }
  }

  drawFormatBits(canvas, 0);
  drawVersionBits(canvas, version);
}

/** Isi area data dengan zig-zag dua kolom dari kanan-bawah. */
function drawCodewords(canvas: QrCanvas, data: readonly number[]): void {
  const size = canvas.modules.length;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (canvas.reserved[row]?.[col] === true) continue;
        if (bit >= data.length * 8) continue;
        const byte = data[bit >>> 3] ?? 0;
        const rowModules = canvas.modules[row];
        if (rowModules === undefined) continue;
        rowModules[col] = bitOf(byte, 7 - (bit & 7));
        bit++;
      }
    }
  }
}

/** Syarat pembalikan modul untuk sebuah mask (0..7). */
export function qrMaskCondition(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (col + row) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (col + row) % 3 === 0;
    case 4:
      return (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0;
    case 5:
      return (col * row) % 2 + (col * row) % 3 === 0;
    case 6:
      return ((col * row) % 2 + (col * row) % 3) % 2 === 0;
    case 7:
      return ((col + row) % 2 + (col * row) % 3) % 2 === 0;
    default:
      throw new Error("Mask QR tak dikenal.");
  }
}

/** Terapkan pembalikan modul pada area data saja. */
function applyMask(canvas: QrCanvas, mask: number): void {
  const size = canvas.modules.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (canvas.reserved[row]?.[col] === true) continue;
      if (!qrMaskCondition(mask, row, col)) continue;
      const rowModules = canvas.modules[row];
      if (rowModules === undefined) continue;
      rowModules[col] = !rowModules[col];
    }
  }
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Skor penalti (N1..N4) standar untuk memilih mask. */
function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let result = 0;

  const addHistory = (runLength: number, history: number[]): void => {
    let length = runLength;
    if (history[0] === 0) length += size;
    history.pop();
    history.unshift(length);
  };
  const countPatterns = (history: number[]): number => {
    const n = history[1] ?? 0;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n ? 1 : 0) +
      (core && (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n ? 1 : 0)
    );
  };
  const terminateAndCount = (
    currentColor: boolean,
    currentLength: number,
    history: number[],
  ): number => {
    let length = currentLength;
    if (currentColor) {
      addHistory(length, history);
      length = 0;
    }
    addHistory(length + size, history);
    return countPatterns(history);
  };

  for (let row = 0; row < size; row++) {
    let runColor = false;
    let runLength = 0;
    const history = new Array<number>(7).fill(0);
    for (let col = 0; col < size; col++) {
      if ((modules[row]?.[col] ?? false) === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result++;
      } else {
        addHistory(runLength, history);
        if (!runColor) result += countPatterns(history) * PENALTY_N3;
        runColor = modules[row]?.[col] ?? false;
        runLength = 1;
      }
    }
    result += terminateAndCount(runColor, runLength, history) * PENALTY_N3;
  }

  for (let col = 0; col < size; col++) {
    let runColor = false;
    let runLength = 0;
    const history = new Array<number>(7).fill(0);
    for (let row = 0; row < size; row++) {
      if ((modules[row]?.[col] ?? false) === runColor) {
        runLength++;
        if (runLength === 5) result += PENALTY_N1;
        else if (runLength > 5) result++;
      } else {
        addHistory(runLength, history);
        if (!runColor) result += countPatterns(history) * PENALTY_N3;
        runColor = modules[row]?.[col] ?? false;
        runLength = 1;
      }
    }
    result += terminateAndCount(runColor, runLength, history) * PENALTY_N3;
  }

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const color = modules[row]?.[col] ?? false;
      if (
        color === (modules[row]?.[col + 1] ?? false) &&
        color === (modules[row + 1]?.[col] ?? false) &&
        color === (modules[row + 1]?.[col + 1] ?? false)
      ) {
        result += PENALTY_N2;
      }
    }
  }

  let dark = 0;
  for (const row of modules) {
    for (const color of row) {
      if (color) dark++;
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * PENALTY_N4;
  return result;
}

/** Hasil penulisan kode QR beserta versi dan mask yang dipakai. */
export interface QrResult {
  /** Matriks modul tanpa quiet zone: `modules[baris][kolom]`, true = gelap. */
  modules: boolean[][];
  /** Versi QR (1 sampai 10). */
  version: number;
  /** Indeks mask yang dipilih (0 sampai 7). */
  mask: number;
}

/**
 * Tulis kode QR untuk teks yang diberikan (UTF-8, mode byte, koreksi M).
 * Melempar `Error` bila teks tak muat pada versi 1 sampai 10.
 */
export function encodeQrDetailed(text: string): QrResult {
  const byteLength = new TextEncoder().encode(text).length;
  const version = pickVersion(byteLength);
  const codewords = buildDataCodewords(text, version);
  const interleaved = interleaveBlocks(codewords, version);

  const canvas = createCanvas(qrSize(version));
  drawFunctionPatterns(canvas, version);
  drawCodewords(canvas, interleaved);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(canvas, mask);
    drawFormatBits(canvas, mask);
    const penalty = penaltyScore(canvas.modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(canvas, mask);
  }
  applyMask(canvas, bestMask);
  drawFormatBits(canvas, bestMask);

  return { modules: canvas.modules, version, mask: bestMask };
}

/** Matriks modul kode QR tanpa quiet zone. */
export function encodeQr(text: string): boolean[][] {
  return encodeQrDetailed(text).modules;
}

/** Info format yang terbaca dari matriks kode QR. */
export interface QrFormatInfo {
  /** Bits tingkat koreksi: 01=L, 00=M, 11=Q, 10=H. */
  errorCorrection: number;
  /** Indeks mask (0 sampai 7). */
  mask: number;
  /** Bits mentah salinan pertama. */
  first: number;
  /** Bits mentah salinan kedua. */
  second: number;
}

/** Baca satu salinan info format (15 bit) dari matriks. */
function readFormatBits(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let bits = 0;
  for (let i = 0; i <= 5; i++) {
    if (modules[i]?.[8] === true) bits |= 1 << i;
  }
  if (modules[7]?.[8] === true) bits |= 1 << 6;
  if (modules[8]?.[8] === true) bits |= 1 << 7;
  if (modules[8]?.[7] === true) bits |= 1 << 8;
  for (let i = 9; i < 15; i++) {
    if (modules[8]?.[14 - i] === true) bits |= 1 << i;
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8]?.[size - 1 - i] === true) bits |= 1 << i;
  }
  for (let i = 8; i < 15; i++) {
    if (modules[size - 15 + i]?.[8] === true) bits |= 1 << i;
  }
  return bits;
}

/** Uji BCH info format: kembalikan data 5 bit bila sah. */
function decodeFormatBits(raw: number): number | undefined {
  const unmasked = raw ^ FORMAT_XOR;
  const data = (unmasked >>> 10) & 0x1f;
  const remainder = unmasked & 0x3ff;
  let check = data;
  for (let i = 0; i < 10; i++) {
    check = (check << 1) ^ ((check >>> 9) * FORMAT_GENERATOR);
  }
  if (check !== remainder) return undefined;
  return data;
}

/**
 * Baca info format dari matriks. Kembalikan `undefined` bila salah satu
 * salinan tidak lolos BCH atau kedua salinan berbeda.
 */
export function readFormatInfo(
  modules: readonly (readonly boolean[])[],
): QrFormatInfo | undefined {
  const first = readFormatBits(modules);
  const second = readFormatBits(modules);
  const dataFirst = decodeFormatBits(first);
  const dataSecond = decodeFormatBits(second);
  if (dataFirst === undefined || dataSecond === undefined) return undefined;
  if (dataFirst !== dataSecond) return undefined;
  return {
    errorCorrection: (dataFirst >>> 3) & 0x3,
    mask: dataFirst & 0x7,
    first,
    second,
  };
}

/**
 * Baca info versi (18 bit) dari matriks. Kembalikan `undefined` bila versi
 * di bawah 7 atau BCH-nya tidak sah.
 */
export function readVersionInfo(
  modules: readonly (readonly boolean[])[],
): number | undefined {
  const size = modules.length;
  if (size < 45) return undefined;
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    const bitA = modules[b]?.[a] === true;
    const bitB = modules[a]?.[b] === true;
    if (bitA !== bitB) return undefined;
    if (bitA) bits |= 1 << i;
  }
  const version = (bits >>> 12) & 0x3f;
  const remainder = bits & 0xfff;
  let check = version;
  for (let i = 0; i < 12; i++) {
    check = (check << 1) ^ ((check >>> 11) * VERSION_GENERATOR);
  }
  if (check !== remainder) return undefined;
  return version;
}

/**
 * Path SVG untuk modul gelap: satu path gabungan, koefisien dalam satuan
 * modul dan tanpa quiet zone.
 */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  const size = modules.length;
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (modules[row]?.[col] !== true) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < size && modules[row]?.[col + run] === true) run++;
      parts.push(`M${col} ${row}h${run}v1h-${run}z`);
      col += run;
    }
  }
  return parts.join("");
}
