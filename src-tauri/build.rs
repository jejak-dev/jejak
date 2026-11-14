fn main() {
  // Perintah IPC aplikasi didaftarkan sebagai perintah aplikasi agar izin
  // `allow-*` dibuat otomatis dan hanya diberikan ke jendela `main`.
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "desktop_info",
        "updater_get_settings",
        "updater_set_settings",
        "updater_check",
        "updater_status",
        "updater_install",
        "updater_restart",
      ]),
    ),
  )
  .expect("gagal membangun manifes aplikasi");
}
