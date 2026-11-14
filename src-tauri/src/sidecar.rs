//! Logika murni sisi sidecar: parsing pengumuman siap, URL masuk sekali
//! pakai, dan daftar putih navigasi webview.
//!
//! Semua fungsi di sini bebas dari API Tauri selain tipe `Url`, sehingga
//! bisa diuji tanpa menjalankan aplikasi.

use tauri::Url;

/// Awalan baris pengumuman server siap (baca mesin).
pub const READY_PREFIX: &str = "JEJAK_READY";

/// Jalur rute masuk sekali pakai di server.
pub const ENTER_PATH: &str = "/__desktop/enter";

/// Host loopback yang dipakai mode desktop.
pub const HOST_LOOPBACK: &str = "127.0.0.1";

/// Host halaman aplikasi lokal milik Tauri di Windows dan Linux.
pub const HOST_APP_LOKAL: &str = "tauri.localhost";

/// Informasi dari baris pengumuman server siap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyInfo {
  /// Port acak yang dipakai server.
  pub port: u16,
  /// Host yang didengarkan server.
  pub host: String,
  /// Versi Jejak yang berjalan.
  pub version: String,
}

/// Baca satu baris output stdout sidecar.
///
/// `Ok(None)` berarti baris itu bukan pengumuman siap (diabaikan).
/// `Err` berarti baris pengumuman tapi payloadnya rusak.
pub fn parse_ready_line(baris: &str) -> Result<Option<ReadyInfo>, String> {
  let baris = baris.trim_end_matches(['\r', '\n']);
  let Some(sisa) = baris.strip_prefix(READY_PREFIX) else {
    return Ok(None);
  };
  match sisa.chars().next() {
    None => return Err("baris JEJAK_READY tanpa payload JSON".to_string()),
    Some(c) if c.is_whitespace() => {}
    Some(_) => {
      // Bukan pengumuman (mis. "JEJAK_READYX"); diabaikan.
      return Ok(None);
    }
  }
  let isi = sisa.trim();
  if isi.is_empty() {
    return Err("baris JEJAK_READY tanpa payload JSON".to_string());
  }
  let nilai: serde_json::Value = serde_json::from_str(isi)
    .map_err(|galat| format!("payload JEJAK_READY bukan JSON yang sah: {galat}"))?;
  let port = nilai
    .get("port")
    .and_then(serde_json::Value::as_u64)
    .ok_or_else(|| "payload JEJAK_READY tanpa port".to_string())?;
  if port == 0 || port > u64::from(u16::MAX) {
    return Err(format!("port JEJAK_READY di luar rentang: {port}"));
  }
  let host = nilai
    .get("host")
    .and_then(serde_json::Value::as_str)
    .unwrap_or(HOST_LOOPBACK)
    .to_string();
  let version = nilai
    .get("version")
    .and_then(serde_json::Value::as_str)
    .unwrap_or("")
    .to_string();
  Ok(Some(ReadyInfo {
    port: port as u16,
    host,
    version,
  }))
}

/// Basis URL halaman aplikasi lokal milik Tauri.
///
/// macOS dan Linux memakai skema `tauri://localhost`; di Windows wry memakai
/// `http://tauri.localhost`.
fn dasar_url_lokal() -> &'static str {
  #[cfg(target_os = "windows")]
  {
    "http://tauri.localhost"
  }
  #[cfg(not(target_os = "windows"))]
  {
    "tauri://localhost"
  }
}

/// URL halaman aplikasi lokal (mis. "index.html") milik Tauri.
pub fn app_url(path: &str) -> Url {
  let url = format!(
    "{}/{}",
    dasar_url_lokal(),
    path.trim_start_matches('/')
  );
  Url::parse(&url).expect("URL halaman aplikasi lokal harus valid")
}

/// Triple Rust untuk platform yang sedang berjalan, atau `None` bila platform
/// ini tak punya triple yang dikenali.
pub fn triple_platform() -> Option<&'static str> {
  match (std::env::consts::OS, std::env::consts::ARCH) {
    ("macos", "aarch64") => Some("aarch64-apple-darwin"),
    ("macos", "x86_64") => Some("x86_64-apple-darwin"),
    ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
    _ => None,
  }
}

/// Bangun URL masuk sekali pakai untuk port tertentu.
pub fn enter_url(port: u16, token: &str) -> String {
  format!("http://{HOST_LOOPBACK}:{port}{ENTER_PATH}?t={token}")
}

/// True bila URL adalah halaman aplikasi lokal milik Tauri.
pub fn is_local_app_url(url: &str) -> bool {
  let Ok(parsed) = Url::parse(url) else {
    return false;
  };
  parsed.scheme() == "tauri" || parsed.host_str() == Some(HOST_APP_LOKAL)
}

/// True bila URL boleh dimuat di webview utama aplikasi.
///
/// Yang diizinkan: halaman aplikasi lokal milik Tauri dan server Jejak di
/// loopback pada port yang sedang dipakai. Tautan ke host lain diblokir.
pub fn is_allowed_navigation(url: &str, port: u16) -> bool {
  let Ok(parsed) = Url::parse(url) else {
    return false;
  };
  if is_local_app_url(url) {
    return true;
  }
  if parsed.scheme() != "http" || port == 0 {
    return false;
  }
  parsed.host_str() == Some(HOST_LOOPBACK) && parsed.port() == Some(port)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn baris_ready_sah_dibaca() {
    let hasil = parse_ready_line("JEJAK_READY {\"port\":51234,\"host\":\"127.0.0.1\",\"version\":\"0.0.1\"}")
      .expect("baris sah tak boleh galat");
    let info = hasil.expect("baris ready harus menghasilkan info");
    assert_eq!(info.port, 51234);
    assert_eq!(info.host, "127.0.0.1");
    assert_eq!(info.version, "0.0.1");
  }

  #[test]
  fn baris_bukan_ready_diabaikan() {
    assert_eq!(parse_ready_line("Data: /Users/jejak/.jejak").expect("baris biasa"), None);
    assert_eq!(parse_ready_line("").expect("baris kosong"), None);
    assert_eq!(parse_ready_line("JEJAK_READYX {\"port\":1}").expect("awalan mirip"), None);
  }

  #[test]
  fn json_rusak_masih_galat() {
    assert!(parse_ready_line("JEJAK_READY {bukan json").is_err());
    assert!(parse_ready_line("JEJAK_READY").is_err());
    assert!(parse_ready_line("JEJAK_READY {\"host\":\"127.0.0.1\"}").is_err());
  }

  #[test]
  fn port_di_luar_rentang_galat() {
    assert!(parse_ready_line("JEJAK_READY {\"port\":0}").is_err());
    assert!(parse_ready_line("JEJAK_READY {\"port\":70000}").is_err());
  }

  #[test]
  fn url_masuk_memuat_token_apa_adanya() {
    let token = "Abc-_123XYZ";
    let url = enter_url(51234, token);
    assert_eq!(url, "http://127.0.0.1:51234/__desktop/enter?t=Abc-_123XYZ");
    assert!(!url.contains('%'), "token tak boleh di-escape: {url}");
    assert!(url.contains("127.0.0.1"), "host harus loopback: {url}");
  }

  #[test]
  fn url_aplikasi_lokal_menunjuk_halaman_tauri() {
    let url = app_url("index.html");
    assert!(is_local_app_url(url.as_str()), "url: {url}");
    assert!(url.as_str().ends_with("index.html"), "url: {url}");
  }

  #[test]
  fn triple_platform_dikenal_di_macos_dan_windows() {
    let triple = triple_platform().expect("platform ini harus punya triple");
    assert!(
      ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]
        .contains(&triple),
      "triple: {triple}",
    );
  }

  #[test]
  fn navigasi_hanya_boleh_server_loopback_dan_halaman_lokal() {
    assert!(is_allowed_navigation("http://127.0.0.1:51234/", 51234));
    assert!(is_allowed_navigation("http://127.0.0.1:51234/__desktop/enter?t=abc", 51234));
    assert!(!is_allowed_navigation("http://127.0.0.1:9999/", 51234));
    assert!(!is_allowed_navigation("http://example.com/", 51234));
    assert!(!is_allowed_navigation("https://127.0.0.1:51234/", 51234));
    assert!(!is_allowed_navigation("http://127.0.0.1:51234/", 0));
    assert!(is_allowed_navigation("tauri://localhost/index.html", 51234));
    assert!(is_allowed_navigation("http://tauri.localhost/index.html", 51234));
    assert!(!is_allowed_navigation("http://localhost:51234/", 51234));
    assert!(!is_allowed_navigation("bukan url", 51234));
  }
}
