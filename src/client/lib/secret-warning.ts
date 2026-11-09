import { redactSecrets } from "../../server/security/redact";

export interface SecretWarning {
  /** Jenis rahasia yang terdeteksi, unik dan terurut. */
  kinds: string[];
  /** Kalimat siap tampil; tidak pernah memuat nilai atau potongan teks. */
  message: string;
}

const MAX_KINDS = 3;

/**
 * Peringatan ringan untuk teks yang akan dikirim. Memakai penyamar yang sama
 * dengan server, tetapi hanya melaporkan jenisnya.
 */
export function secretWarning(text: string): SecretWarning | undefined {
  if (text.trim() === "") return undefined;
  const { hits } = redactSecrets(text);
  if (hits.length === 0) return undefined;

  const kinds = [...new Set(hits.map((hit) => hit.kind))].sort();
  const shown = kinds.slice(0, MAX_KINDS);
  const list = kinds.length > MAX_KINDS ? `${shown.join(", ")}, dan lainnya` : shown.join(", ");

  return {
    kinds,
    message: `Teks ini tampak berisi rahasia (${list}). Jangan kirim bila tidak perlu.`,
  };
}
