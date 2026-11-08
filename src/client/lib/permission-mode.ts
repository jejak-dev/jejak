/** Mode izin yang bisa dipilih di composer; `bypassPermissions` sengaja per sesi. */
export type ComposerPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Mode yang boleh diingat sebagai pilihan awal berikutnya. */
export type StoredPermissionMode = "default" | "acceptEdits" | "plan";

export const BYPASS_WARNING =
  "Agent akan menjalankan perintah dan mengubah berkas tanpa bertanya, dengan hak akses akunmu. Instruksi tersembunyi di berkas atau halaman web bisa ikut dijalankan.";

/** Kirim hanya bila pengguna sudah mencentang pernyataan risiko pada mode bypass. */
export function canSubmitMode(mode: ComposerPermissionMode, acknowledged: boolean): boolean {
  return mode !== "bypassPermissions" || acknowledged;
}

/** `undefined` berarti mode tidak disimpan; bypass tidak pernah menjadi pilihan awal. */
export function storableMode(mode: ComposerPermissionMode): StoredPermissionMode | undefined {
  return mode === "bypassPermissions" ? undefined : mode;
}

/** Nilai storage asing (termasuk "bypassPermissions") dibaca sebagai "default". */
export function storedModeFrom(raw: string | null | undefined): StoredPermissionMode {
  return raw === "acceptEdits" || raw === "plan" ? raw : "default";
}

/** Penanda "Tanpa izin" ditampilkan untuk sesi bermode bypass. */
export function showsBypassMarker(mode: string | undefined): boolean {
  return mode === "bypassPermissions";
}
