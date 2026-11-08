/**
 * Salin teks ke papan klip. Memakai Clipboard API bila ada, lalu fallback
 * textarea + execCommand. Tidak pernah melempar: gagal berarti `false`.
 */

function fallbackCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body?.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } finally {
    area.parentNode?.removeChild(area);
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard =
      typeof navigator === "undefined"
        ? undefined
        : (navigator.clipboard as Clipboard | undefined);
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard API ditolak (izin/tanpa fokus): coba fallback di bawah.
      }
    }
    return fallbackCopy(text);
  } catch {
    return false;
  }
}
