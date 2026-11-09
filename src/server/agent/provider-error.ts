export type ProviderErrorKind = "koneksi" | "auth" | "batas" | "server";

const PATTERNS: ReadonlyArray<{ kind: ProviderErrorKind; pattern: RegExp }> = [
  { kind: "koneksi", pattern: /econnrefused|econnreset|enotfound|etimedout|timeout|timed out|fetch failed|socket|network|tidak dapat terhubung/ },
  // Kata angka dibatasi batas kata agar tidak cocok di tengah angka lain.
  { kind: "auth", pattern: /(?<!\d)(?:401|403)(?!\d)|unauthorized|forbidden|invalid api key|authentication/ },
  { kind: "batas", pattern: /(?<!\d)(?:429)(?!\d)|rate limit|too many requests|quota/ },
  { kind: "server", pattern: /(?<!\d)(?:500|502|503|504|529)(?!\d)|overloaded|bad gateway|service unavailable/ },
];

const REASONS: Record<ProviderErrorKind, string> = {
  koneksi: "koneksi gagal",
  auth: "autentikasi ditolak",
  batas: "batas laju",
  server: "galat server",
};

/** Kategori galat provider dari pesan; `undefined` untuk galat non-provider. */
export function classifyProviderError(message: string): ProviderErrorKind | undefined {
  const text = message.toLowerCase();
  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return undefined;
}

export function describeFallbackReason(kind: ProviderErrorKind): string {
  return REASONS[kind];
}
