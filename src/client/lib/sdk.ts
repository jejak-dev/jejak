import { ApiError, type SdkCheckResult, type SdkCli, type SdkClaude, type SdkClaudeSource, type SdkStatus } from "./api";
import { formatSize as formatBytes } from "./files";

/** Nama paket SDK; sama dengan yang dipakai server. */
export const SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";

/** Host registry yang menjadi sumber tetap; klien tidak pernah mengirim URL. */
export const SDK_REGISTRY_HOST = "registry.npmjs.org";

/** Ketentuan Anthropic yang dirujuk sebelum persetujuan. */
export const SDK_TERMS_URL = "https://www.anthropic.com/legal/commercial-terms";

/** Pernyataan tegas yang wajib tampil sebelum tombol memasang ditekan. */
export const SDK_CONSENT_TEXT =
  "Kode ini akan diunduh dan dijalankan di komputer ini dengan hak akses Anda, setara menjalankan npm install. Tidak ada skrip pemasangan yang dijalankan.";

/** Status SDK dalam satu baris. */
export function sdkStatusLine(status: SdkStatus): string {
  if (status.busy) return "Sedang memasang SDK…";
  if (status.installed === null) return "Belum terpasang";
  return `Terpasang: ${status.installed.version}`;
}

/** Ringkasan status untuk ditampilkan: versi, tanggal, versi sebelumnya, rentang. */
export function sdkStatusFacts(status: SdkStatus): string[] {
  const facts: string[] = [];
  if (status.installed !== null) {
    facts.push(`Versi terpasang: ${status.installed.version}`);
    facts.push(`Tanggal pemasangan: ${status.installed.installedAt}`);
  }
  if (status.previous !== null) {
    facts.push(`Versi sebelumnya: ${status.previous}`);
  }
  if (status.supportedRange !== "") {
    facts.push(`Rentang didukung: ${status.supportedRange}`);
  }
  return facts;
}

/** Perkiraan ukuran terpasang; "tidak diketahui" bila registry tidak menyodorkan angka. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "tidak diketahui";
  return formatBytes(bytes);
}

/** Tombol kembalikan versi sebelumnya hanya ada bila ada versi sebelumnya. */
export function canRollback(status: SdkStatus): boolean {
  return status.previous !== null && status.previous !== "";
}

/** Baris-baris fakta persetujuan; sumber, paket, versi, dan perkiraan ukuran. */
export function confirmationFacts(candidate: SdkCheckResult): string[] {
  const facts = [
    `Sumber: ${SDK_REGISTRY_HOST} (npm)`,
    `Paket: ${SDK_PACKAGE_NAME}`,
    `Versi: ${candidate.candidate}`,
  ];
  if (candidate.note !== undefined && candidate.note !== "") {
    facts.push(`Catatan: ${candidate.note}`);
  }
  facts.push(`Perkiraan ukuran terpasang: ~${formatSize(candidate.unpackedSize)}`);
  return facts;
}

/**
 * Keputusan pemasangan; hanya "pasang" setelah persetujuan eksplisit.
 *
 * Versi yang dikirim sama persis dengan versi yang ditampilkan ke pengguna,
 * jadi kandidat tidak bisa berubah diam-diam antara tampilan dan permintaan.
 */
export type SdkInstallIntent = { kind: "tunggu" } | { kind: "pasang"; version: string };

export function sdkInstallIntent(
  candidate: SdkCheckResult | undefined,
  approved: boolean,
): SdkInstallIntent {
  if (candidate === undefined || candidate.candidate === "") return { kind: "tunggu" };
  if (!approved) return { kind: "tunggu" };
  return { kind: "pasang", version: candidate.candidate };
}

/** Label sumber CLI `claude` dalam bahasa Indonesia. */
export function claudeSourceLabel(source: SdkClaudeSource): string {
  if (source === "env") return "variabel JEJAK_CLAUDE_PATH";
  if (source === "setting") return "pengaturan Jejak";
  if (source === "path") return "PATH sistem";
  return "lokasi umum";
}

/** Status CLI `claude` dalam satu baris. */
export function claudeStatusLine(claude: SdkClaude): string {
  if (!claude.found) return "claude tidak ditemukan";
  return `claude ditemukan: ${claude.version ?? "versi tidak diketahui"}`;
}

/** Fakta CLI `claude`: jalur dan sumbernya. */
export function claudeStatusFacts(claude: SdkClaude): string[] {
  const facts: string[] = [];
  if (claude.path !== null && claude.path !== "") {
    facts.push(`Jalur: ${claude.path}`);
  }
  if (claude.source !== null) {
    facts.push(`Sumber: ${claudeSourceLabel(claude.source)}`);
  }
  return facts;
}

/** Petunjuk singkat saat CLI `claude` belum ditemukan. */
export const CLAUDE_MISSING_HINT =
  "Pasang Claude Code resmi dari terminal, isi jalur CLI di bawah bila sudah terpasang di tempat lain, atau pasang CLI bawaan SDK.";

/* ------------------------------------------------------------ CLI bawaan */

/** Ketentuan Anthropic yang dirujuk sebelum memasang CLI bawaan. */
export const CLI_TERMS_URL = "https://code.claude.com/docs/en/legal-and-compliance";

/** Pernyataan tegas yang wajib tampil sebelum tombol memasang ditekan. */
export const CLI_CONSENT_TEXT =
  "Kode biner Anthropic akan diunduh dan dijalankan di komputer ini dengan hak akses Anda. " +
  "Hak cipta kode biner itu tetap milik Anthropic.";

/** Perkiraan ukuran unduhan tarball CLI bawaan. */
export const CLI_DOWNLOAD_ESTIMATE = "sekitar 150 MB";

/** Status CLI bawaan SDK dalam satu baris. */
export function cliStatusLine(cli: SdkCli): string {
  if (cli.installed !== null) {
    return `CLI bawaan terpasang: ${cli.installed.version}`;
  }
  if (!cli.supported) return "CLI bawaan tidak tersedia di platform ini";
  return "CLI bawaan belum terpasang";
}

/** Baris-baris fakta persetujuan pemasangan CLI bawaan. */
export function cliConsentFacts(info: {
  version: string;
  platform: string;
  unpackedSize: number;
}): string[] {
  return [
    `Versi: ${info.version}`,
    `Platform: ${info.platform}`,
    `Unduhan: ${CLI_DOWNLOAD_ESTIMATE}`,
    `Ukuran terpasang: ~${formatSize(info.unpackedSize)}`,
    `Lokasi: <JEJAK_HOME>/sdk/${info.version}/cli`,
  ];
}

/** Teks kemajuan unduhan CLI bawaan. */
export function cliProgressText(progress: { received: number; total: number | null }): string {
  const received = formatSize(progress.received);
  if (progress.total === null) return `Mengunduh ${received}`;
  return `Mengunduh ${received} dari ${formatSize(progress.total)}`;
}

/** Pesan ramah untuk galat pemasangan CLI bawaan. */
export function describeCliError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return error.message === ""
        ? "Pemasangan lain sedang berjalan. Tunggu sebentar lalu coba lagi."
        : error.message;
    }
    if (error.status === 507) {
      return error.message === ""
        ? "Ruang disk tidak cukup. Siapkan sekitar 1 GB ruang kosong lalu coba lagi."
        : error.message;
    }
    if (error.status === 502) {
      return error.message === ""
        ? "Tidak bisa menghubungi registry npm. Periksa koneksi internet lalu coba lagi."
        : error.message;
    }
    if (error.status === 422) {
      return error.message === ""
        ? "Unduhan ditolak: isi paket tidak aman atau tidak lengkap."
        : error.message;
    }
    if (error.message !== "") return error.message;
    return "Terjadi kesalahan saat menangani CLI bawaan SDK.";
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "Terjadi kesalahan saat menangani CLI bawaan SDK.";
}

/** Pesan ramah untuk galat pengaturan jalur CLI. */
export function describeClaudeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 && error.message !== "") return error.message;
    if (error.status === 404 || error.status === 409 || error.status === 502) {
      return error.message === ""
        ? "Permintaan ditolak server."
        : error.message;
    }
    return error.message === ""
      ? "Terjadi kesalahan saat menangani pengaturan claude."
      : error.message;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "Terjadi kesalahan saat menangani pengaturan claude.";
}

/** Pesan ramah untuk galat SDK; status HTTP dipetakan ke penjelasan. */
export function describeSdkError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 502) {
      return "Tidak bisa menghubungi registry npm. Periksa koneksi internet lalu coba lagi.";
    }
    if (error.status === 422) {
      return "Unduhan ditolak: integritas atau isi paket tidak aman. Tidak ada yang dipasang.";
    }
    if (error.status === 409) {
      return "Pemasangan SDK sedang berjalan. Tunggu sebentar lalu coba lagi.";
    }
    if (error.status === 400 || error.status === 404) {
      return error.message === "" ? "Permintaan ditolak server." : error.message;
    }
    return error.message === "" ? "Terjadi kesalahan saat menangani SDK." : error.message;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "Terjadi kesalahan saat menangani SDK.";
}
