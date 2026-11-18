/**
 * Pendekkan path panjang dengan elipsis di tengah, sambil mempertahankan nama
 * folder terakhir. Bila nama folder terakhir sendiri tidak muat, bagian
 * belakangnya yang dipertahankan agar masih bisa dikenali.
 */
export function shortenPath(path: string, max: number): string {
  if (max <= 0) return "";
  if (path.length <= max) return path;
  if (max === 1) return "…";

  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  const last = segments[segments.length - 1] ?? path;
  const suffix = `…/${last}`;

  if (suffix.length > max) {
    const room = max - 1;
    return `…${last.slice(Math.max(0, last.length - room))}`;
  }

  const room = max - suffix.length;
  let head = "";
  for (const segment of segments.slice(0, -1)) {
    const candidate = `${head}/${segment}`;
    if (candidate.length + 1 > room) break;
    head = candidate;
  }

  return head === "" ? suffix : `${head}/${suffix}`;
}
