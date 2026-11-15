//! Pembaru otomatis Jejak: pengaturan kanal, status, dan perintah IPC.
//!
//! Modul ini tak pernah memasang atau menyalakan ulang aplikasi dengan
//! sendirinya. Unduhan hanya berjalan setelah UI memanggil `updater_install`,
//! dan restart hanya setelah `updater_restart`. Pemeriksaan otomatis hanya
//! melakukan permintaan GET ke endpoint rilis.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Kanal pembaruan stabil.
pub const KANAL_STABIL: &str = "stable";

/// Kanal pembaruan beta.
pub const KANAL_BETA: &str = "beta";

/// Endpoint kanal stabil.
pub const ENDPOINT_STABIL: &str =
  "https://github.com/jejak-dev/jejak/releases/latest/download/latest.json";

/// Endpoint kanal beta.
pub const ENDPOINT_BETA: &str =
  "https://github.com/jejak-dev/jejak/releases/download/beta/latest.json";

/// Nama berkas pengaturan di dalam folder konfigurasi aplikasi.
pub const NAMA_BERKAS: &str = "desktop.json";

/// Pesan ramah saat kanal stabil belum punya berkas rilis.
pub const PESAN_BELUM_ADA_RILIS_STABIL: &str = "Belum ada rilis stabil. Pilih kanal Beta di Pengaturan.";

/// Jeda sebelum pemeriksaan otomatis pertama (detik).
const JEDA_AWAL: Duration = Duration::from_secs(15);

/// Jarak antar pemeriksaan otomatis (detik): enam jam.
const INTERVAL_PERIKSA: Duration = Duration::from_secs(6 * 60 * 60);

/// Pengaturan pembaruan yang disimpan pengguna.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pengaturan {
  /// Apakah pemeriksaan otomatis diizinkan.
  #[serde(default = "bawaan_auto_check")]
  pub auto_check: bool,
  /// Kanal pembaruan: `stable` atau `beta`.
  #[serde(default = "bawaan_kanal")]
  pub channel: String,
}

/// Bawaan untuk `autoCheck`.
fn bawaan_auto_check() -> bool {
  true
}

/// Bawaan untuk `channel`.
///
/// Versi pra-rilis (memuat `-`, misalnya `0.1.0-beta.4`) memakai kanal beta;
/// versi rilis penuh memakai kanal stabil.
fn bawaan_kanal() -> String {
  kanal_bawaan_untuk(env!("CARGO_PKG_VERSION"))
}

/// Kanal bawaan menurut nomor versi aplikasi.
///
/// Versi pra-rilis memakai kanal beta karena semua rilis Jejak sementara ini
/// berupa pra-rilis; kanal stabil baru diisi saat rilis penuh terbit.
pub fn kanal_bawaan_untuk(versi: &str) -> String {
  if versi.contains('-') {
    KANAL_BETA.to_string()
  } else {
    KANAL_STABIL.to_string()
  }
}

impl Default for Pengaturan {
  fn default() -> Self {
    Self {
      auto_check: bawaan_auto_check(),
      channel: bawaan_kanal(),
    }
  }
}

/// Informasi dasar aplikasi desktop.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoDesktop {
  /// Versi aplikasi yang sedang berjalan.
  pub version: String,
  /// Platform: `macos`, `windows`, atau `linux`.
  pub platform: String,
}

/// Tahap pembaruan yang sedang berjalan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tahap {
  /// Tak ada pemeriksaan yang berjalan.
  Idle,
  /// Pemeriksaan ke server sedang berjalan.
  Checking,
  /// Ada pembaruan yang menunggu dipasang.
  Available,
  /// Pembaruan sedang diunduh.
  Downloading,
  /// Pembaruan sedang dipasang.
  Installing,
  /// Pembaruan terpasang; aplikasi bisa dimulai ulang.
  Ready,
  /// Pemeriksaan atau pemasangan gagal.
  Error,
}

/// Keadaan pembaruan yang dilihat UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
  /// Tahap saat ini.
  pub state: Tahap,
  /// Versi pembaruan yang tersedia.
  pub version: Option<String>,
  /// Catatan rilis yang disertakan.
  pub notes: Option<String>,
  /// Tanggal rilis.
  pub date: Option<String>,
  /// Bytes yang sudah diunduh.
  pub downloaded: u64,
  /// Total bytes bila diketahui.
  pub total: Option<u64>,
  /// Pesan galat singkat.
  pub error: Option<String>,
  /// Epoch detik pemeriksaan terakhir.
  pub last_check: Option<u64>,
}

impl Default for Status {
  fn default() -> Self {
    Self {
      state: Tahap::Idle,
      version: None,
      notes: None,
      date: None,
      downloaded: 0,
      total: None,
      error: None,
      last_check: None,
    }
  }
}

/// Peristiwa yang mengubah status pembaruan.
#[derive(Debug, Clone, PartialEq)]
pub enum Peristiwa {
  /// Pemeriksaan dimulai.
  MulaiPeriksa {
    /// Epoch detik saat pemeriksaan dimulai.
    waktu: u64,
  },
  /// Pemeriksaan selesai.
  SelesaiPeriksa {
    /// Epoch detik saat pemeriksaan selesai.
    waktu: u64,
    /// Versi pembaruan bila ada.
    versi: Option<String>,
    /// Catatan rilis bila ada.
    catatan: Option<String>,
    /// Tanggal rilis bila ada.
    tanggal: Option<String>,
  },
  /// Unduhan dimulai.
  MulaiUnduh,
  /// Potongan unduhan diterima.
  Progres {
    /// Total bytes yang sudah diunduh.
    terunduh: u64,
    /// Total bytes bila diketahui.
    total: Option<u64>,
  },
  /// Unduhan selesai; pemasangan dimulai.
  SelesaiUnduh,
  /// Pemasangan selesai.
  SelesaiPasang,
  /// Pemeriksaan atau pemasangan gagal.
  Gagal {
    /// Epoch detik saat galat terjadi.
    waktu: u64,
    /// Pesan galat singkat.
    pesan: String,
  },
  /// Pembaruan yang tertahan dibuang.
  BuangTertahan,
}

/// Terapkan satu peristiwa pada status; mengembalikan `true` bila berubah.
pub fn terapkan(status: &mut Status, peristiwa: &Peristiwa) -> bool {
  match peristiwa {
    Peristiwa::MulaiPeriksa { waktu } => {
      // Pemeriksaan baru hanya boleh saat idle atau setelah galat.
      if !matches!(status.state, Tahap::Idle | Tahap::Error) {
        return false;
      }
      status.state = Tahap::Checking;
      status.version = None;
      status.notes = None;
      status.date = None;
      status.downloaded = 0;
      status.total = None;
      status.error = None;
      status.last_check = Some(*waktu);
      true
    }
    Peristiwa::SelesaiPeriksa {
      waktu,
      versi,
      catatan,
      tanggal,
    } => {
      if status.state != Tahap::Checking {
        return false;
      }
      status.last_check = Some(*waktu);
      status.error = None;
      match versi {
        Some(versi) => {
          status.state = Tahap::Available;
          status.version = Some(versi.clone());
          status.notes = catatan.clone();
          status.date = tanggal.clone();
        }
        None => {
          status.state = Tahap::Idle;
          status.version = None;
          status.notes = None;
          status.date = None;
        }
      }
      true
    }
    Peristiwa::MulaiUnduh => {
      if status.state != Tahap::Available {
        return false;
      }
      status.state = Tahap::Downloading;
      status.downloaded = 0;
      status.total = None;
      status.error = None;
      true
    }
    Peristiwa::Progres { terunduh, total } => {
      if status.state != Tahap::Downloading {
        return false;
      }
      status.downloaded = *terunduh;
      status.total = *total;
      true
    }
    Peristiwa::SelesaiUnduh => {
      if status.state != Tahap::Downloading {
        return false;
      }
      status.state = Tahap::Installing;
      true
    }
    Peristiwa::SelesaiPasang => {
      if status.state != Tahap::Installing {
        return false;
      }
      status.state = Tahap::Ready;
      true
    }
    Peristiwa::Gagal { waktu, pesan } => {
      let sebelumnya = status.state;
      status.state = Tahap::Error;
      status.error = Some(pesan.clone());
      if sebelumnya == Tahap::Checking {
        status.last_check = Some(*waktu);
      }
      true
    }
    Peristiwa::BuangTertahan => {
      if status.state != Tahap::Available {
        return false;
      }
      status.state = Tahap::Idle;
      status.version = None;
      status.notes = None;
      status.date = None;
      true
    }
  }
}

/// Apakah kanal pembaruan didukung.
pub fn kanal_sah(kanal: &str) -> bool {
  kanal == KANAL_STABIL || kanal == KANAL_BETA
}

/// Petakan galat pemeriksaan menjadi pesan yang enak dibaca.
///
/// Galat kanal stabil yang menandakan berkas rilis belum ada diganti pesan
/// ramah; galat lain tetap memakai bentuk bawaan.
pub fn pesan_galat_pemeriksaan(kanal: &str, galat: &str) -> String {
  if kanal == KANAL_STABIL && menandakan_rilis_belum_ada(galat) {
    return PESAN_BELUM_ADA_RILIS_STABIL.to_string();
  }
  format!("pemeriksaan pembaruan gagal: {galat}")
}

/// Apakah pesan galat menandakan endpoint kanal belum punya berkas rilis.
fn menandakan_rilis_belum_ada(galat: &str) -> bool {
  let huruf_kecil = galat.to_lowercase();
  huruf_kecil.contains("404") || huruf_kecil.contains("valid release json")
}

/// Baca pengaturan dari teks JSON; kanal tak dikenal ditolak.
pub fn parse_pengaturan(teks: &str) -> Result<Pengaturan, String> {
  let nilai: Pengaturan =
    serde_json::from_str(teks).map_err(|_| "berkas pengaturan tak bisa dibaca".to_string())?;
  if !kanal_sah(&nilai.channel) {
    return Err("kanal pembaruan tak dikenal".to_string());
  }
  Ok(nilai)
}

/// Serialkan pengaturan ke JSON.
pub fn serialize_pengaturan(pengaturan: &Pengaturan) -> Result<String, String> {
  serde_json::to_string_pretty(pengaturan)
    .map_err(|_| "pengaturan tak bisa diserialkan".to_string())
}

/// Muat pengaturan dari disk; berkas hilang atau rusak memakai bawaan.
pub fn muat_pengaturan(path: &Path) -> Pengaturan {
  let Ok(teks) = std::fs::read_to_string(path) else {
    return Pengaturan::default();
  };
  parse_pengaturan(&teks).unwrap_or_default()
}

/// Simpan pengaturan secara atomik: tulis berkas sementara lalu rename.
pub fn simpan_pengaturan(path: &Path, pengaturan: &Pengaturan) -> Result<(), String> {
  let isi = serialize_pengaturan(pengaturan)?;
  let folder = path
    .parent()
    .ok_or_else(|| "alamat berkas pengaturan tak punya folder".to_string())?;
  std::fs::create_dir_all(folder).map_err(|_| "folder konfigurasi tak bisa dibuat".to_string())?;
  let sementara = path.with_extension("json.tmp");
  std::fs::write(&sementara, isi).map_err(|_| "berkas pengaturan tak bisa ditulis".to_string())?;
  std::fs::rename(&sementara, path).map_err(|_| "berkas pengaturan tak bisa disimpan".to_string())?;
  Ok(())
}

/// Endpoint baku untuk sebuah kanal.
pub fn endpoint_kanal(kanal: &str) -> Option<&'static str> {
  match kanal {
    KANAL_STABIL => Some(ENDPOINT_STABIL),
    KANAL_BETA => Some(ENDPOINT_BETA),
    _ => None,
  }
}

/// Endpoint efektif dengan override opsional.
pub fn endpoint_dengan_override(kanal: &str, override_debug: Option<&str>) -> Option<String> {
  if let Some(nilai) = override_debug {
    let nilai = nilai.trim();
    if !nilai.is_empty() {
      return Some(nilai.to_string());
    }
  }
  endpoint_kanal(kanal).map(|nilai| nilai.to_string())
}

/// Endpoint efektif menurut kanal.
///
/// Env `JEJAK_UPDATE_ENDPOINT` hanya dibaca pada build debug; build release
/// selalu memakai endpoint https bawaan.
pub fn endpoint_efektif(kanal: &str) -> Option<String> {
  let override_debug = if cfg!(debug_assertions) {
    std::env::var("JEJAK_UPDATE_ENDPOINT").ok()
  } else {
    None
  };
  let endpoint = endpoint_dengan_override(kanal, override_debug.as_deref())?;
  // Build release tak pernah memakai endpoint http.
  if !cfg!(debug_assertions) && !endpoint.starts_with("https://") {
    return None;
  }
  Some(endpoint)
}

/// Status bersama antar utas untuk modul pembaru.
pub struct UpdaterState {
  /// Status pembaruan terakhir.
  pub status: Mutex<Status>,
  /// Pengaturan yang berlaku saat ini.
  pub pengaturan: Mutex<Pengaturan>,
  /// Alamat berkas pengaturan.
  pub path: PathBuf,
  /// Pembaruan yang tertahan, siap dipasang.
  pub update: Mutex<Option<Update>>,
  /// Penanda pemeriksaan atau pemasangan yang sedang berjalan.
  pub sibuk: AtomicBool,
}

impl UpdaterState {
  /// Buat state baru; pengaturan dimuat dari `path` bila ada.
  pub fn baru(path: PathBuf) -> Self {
    let pengaturan = muat_pengaturan(&path);
    Self {
      status: Mutex::new(Status::default()),
      pengaturan: Mutex::new(pengaturan),
      path,
      update: Mutex::new(None),
      sibuk: AtomicBool::new(false),
    }
  }
}

/// Kunci mutex tanpa panik saat terkunci karena panik sebelumnya.
fn kunci<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|galat| galat.into_inner())
}

/// Epoch detik sekarang.
fn epoch_sekarang() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|selisih| selisih.as_secs())
    .unwrap_or(0)
}

/// Salinan status saat ini.
fn snapshot(state: &UpdaterState) -> Status {
  kunci(&state.status).clone()
}

/// Platform aplikasi saat ini.
pub fn platform_sekarang() -> &'static str {
  if cfg!(target_os = "macos") {
    "macos"
  } else if cfg!(target_os = "windows") {
    "windows"
  } else {
    "linux"
  }
}

/// Informasi versi dan platform aplikasi.
#[tauri::command]
pub fn desktop_info(app: AppHandle) -> Result<InfoDesktop, String> {
  Ok(InfoDesktop {
    version: app.package_info().version.to_string(),
    platform: platform_sekarang().to_string(),
  })
}

/// Pengaturan pembaruan yang berlaku.
#[tauri::command]
pub fn updater_get_settings(app: AppHandle) -> Result<Pengaturan, String> {
  let state = app.state::<UpdaterState>();
  Ok(kunci(&state.pengaturan).clone())
}

/// Simpan pengaturan pembaruan yang baru.
///
/// Bentuk arguumen diterima dalam dua bentuk: bersarang (`{settings: {..}}`)
/// atau datar (`{autoCheck: .., channel: ..}`).
#[tauri::command]
pub fn updater_set_settings(
  app: AppHandle,
  settings: Option<Pengaturan>,
  auto_check: Option<bool>,
  channel: Option<String>,
) -> Result<Pengaturan, String> {
  let settings = match settings {
    Some(nilai) => nilai,
    None => Pengaturan {
      auto_check: auto_check.ok_or_else(|| "pengaturan pembaruan tak lengkap".to_string())?,
      channel: channel.ok_or_else(|| "pengaturan pembaruan tak lengkap".to_string())?,
    },
  };
  if !kanal_sah(&settings.channel) {
    return Err("kanal pembaruan tak dikenal".to_string());
  }
  let state = app.state::<UpdaterState>();
  let kanal_lama = {
    let mut guard = kunci(&state.pengaturan);
    let kanal_lama = guard.channel.clone();
    *guard = settings.clone();
    kanal_lama
  };
  simpan_pengaturan(&state.path, &settings)?;
  if kanal_lama != settings.channel {
    // Kanal berubah: pembaruan yang tertahan tak lagi relevan.
    let mut status = kunci(&state.status);
    terapkan(&mut status, &Peristiwa::BuangTertahan);
    drop(status);
    kunci(&state.update).take();
  }
  Ok(settings)
}

/// Status pembaruan saat ini tanpa efek samping.
#[tauri::command]
pub fn updater_status(app: AppHandle) -> Result<Status, String> {
  let state = app.state::<UpdaterState>();
  Ok(snapshot(&state))
}

/// Periksa pembaruan; mengembalikan status terbaru.
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<Status, String> {
  Ok(periksa(&app).await)
}

/// Jalankan pemeriksaan pembaruan; hanya satu pemeriksaan pada satu waktu.
async fn periksa(app: &AppHandle) -> Status {
  let state = app.state::<UpdaterState>();
  if state.sibuk.swap(true, Ordering::SeqCst) {
    // Pemeriksaan lain sedang berjalan.
    return snapshot(&state);
  }
  let waktu = epoch_sekarang();
  {
    let mut status = kunci(&state.status);
    if !terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu }) {
      state.sibuk.store(false, Ordering::SeqCst);
      return snapshot(&state);
    }
  }
  let hasil = jalankan_pemeriksaan(app).await;
  let mut status = kunci(&state.status);
  match hasil {
    Ok(Some(update)) => {
      let versi = update.version.clone();
      let catatan = update.body.clone();
      let tanggal = update.date.map(|nilai| nilai.to_string());
      kunci(&state.update).replace(update);
      terapkan(
        &mut status,
        &Peristiwa::SelesaiPeriksa {
          waktu: epoch_sekarang(),
          versi: Some(versi),
          catatan,
          tanggal,
        },
      );
    }
    Ok(None) => {
      kunci(&state.update).take();
      terapkan(
        &mut status,
        &Peristiwa::SelesaiPeriksa {
          waktu: epoch_sekarang(),
          versi: None,
          catatan: None,
          tanggal: None,
        },
      );
    }
    Err(pesan) => {
      terapkan(
        &mut status,
        &Peristiwa::Gagal {
          waktu: epoch_sekarang(),
          pesan,
        },
      );
    }
  }
  drop(status);
  state.sibuk.store(false, Ordering::SeqCst);
  snapshot(&state)
}

/// Minta manifest pembaruan ke server; galat dikembalikan sebagai pesan singkat.
async fn jalankan_pemeriksaan(app: &AppHandle) -> Result<Option<Update>, String> {
  let state = app.state::<UpdaterState>();
  let kanal = kunci(&state.pengaturan).channel.clone();
  let endpoint = endpoint_efektif(&kanal).ok_or_else(|| "kanal pembaruan tak dikenal".to_string())?;
  let url = tauri::Url::parse(&endpoint).map_err(|_| "alamat pembaruan tak valid".to_string())?;
  let builder = app
    .updater_builder()
    .endpoints(vec![url])
    .map_err(|galat| format!("alamat pembaruan ditolak: {galat}"))?;
  let pemeriksa = builder
    .build()
    .map_err(|galat| format!("pemeriksa pembaruan tak bisa disiapkan: {galat}"))?;
  pemeriksa
    .check()
    .await
    .map_err(|galat| pesan_galat_pemeriksaan(&kanal, &galat.to_string()))
}

/// Unduh dan pasang pembaruan yang tertahan; hanya sah bila ada pembaruan.
#[tauri::command]
pub fn updater_install(app: AppHandle) -> Result<Status, String> {
  let state = app.state::<UpdaterState>();
  if state.sibuk.swap(true, Ordering::SeqCst) {
    return Err("pemasangan pembaruan sedang berjalan".to_string());
  }
  let Some(update) = kunci(&state.update).take() else {
    state.sibuk.store(false, Ordering::SeqCst);
    return Err("belum ada pembaruan untuk dipasang".to_string());
  };
  {
    let mut status = kunci(&state.status);
    if !terapkan(&mut status, &Peristiwa::MulaiUnduh) {
      drop(status);
      state.sibuk.store(false, Ordering::SeqCst);
      return Err("belum ada pembaruan untuk dipasang".to_string());
    }
  }
  let handle = app.clone();
  tauri::async_runtime::spawn(async move {
    pasang(handle, update).await;
  });
  Ok(snapshot(&state))
}

/// Unduh dan pasang pembaruan di latar belakang.
async fn pasang(app: AppHandle, update: Update) {
  let handle_progres = app.clone();
  let mut terunduh: u64 = 0;
  let mut total: Option<u64> = None;
  let hasil = update
    .download_and_install(
      |ukuran, panjang| {
        terunduh += ukuran as u64;
        total = panjang;
        let state = handle_progres.state::<UpdaterState>();
        let mut status = kunci(&state.status);
        terapkan(
          &mut status,
          &Peristiwa::Progres {
            terunduh,
            total,
          },
        );
      },
      || {
        let state = handle_progres.state::<UpdaterState>();
        let mut status = kunci(&state.status);
        terapkan(&mut status, &Peristiwa::SelesaiUnduh);
      },
    )
    .await;
  let state = app.state::<UpdaterState>();
  {
    let mut status = kunci(&state.status);
    match hasil {
      Ok(()) => {
        terapkan(&mut status, &Peristiwa::SelesaiPasang);
      }
      Err(_) => {
        terapkan(
          &mut status,
          &Peristiwa::Gagal {
            waktu: epoch_sekarang(),
            pesan: "pemasangan pembaruan gagal".to_string(),
          },
        );
      }
    }
  }
  state.sibuk.store(false, Ordering::SeqCst);
}

/// Mulai ulang aplikasi; hanya sah bila pembaruan sudah siap.
#[tauri::command]
pub fn updater_restart(app: AppHandle) -> Result<(), String> {
  let state = app.state::<UpdaterState>();
  let status = kunci(&state.status);
  if status.state != Tahap::Ready {
    return Err("belum ada pembaruan siap dijalankan".to_string());
  }
  drop(status);
  // Tutup sidecar lebih dulu: `app.restart()` tak selalu mengirim
  // `RunEvent::ExitRequested`, jadi server tak boleh tertinggal.
  crate::hentikan_sidecar(&app);
  app.restart();
}

/// Jalankan pemeriksaan otomatis: sekali setelah mulai, lalu tiap enam jam.
pub fn jalankan_pemeriksaan_otomatis(app: AppHandle) {
  std::thread::spawn(move || {
    std::thread::sleep(JEDA_AWAL);
    loop {
      let otomatis = {
        let state = app.state::<UpdaterState>();
        kunci(&state.pengaturan).auto_check
      };
      if otomatis {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
          periksa(&handle).await;
        });
      }
      std::thread::sleep(INTERVAL_PERIKSA);
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn pengaturan_bawaan() -> Pengaturan {
    Pengaturan::default()
  }

  /// Bawa status ke tahap "ada pembaruan yang tersedia".
  fn ke_tersedia(status: &mut Status) {
    ke_tersedia_dengan(status, "1.2.0", None);
  }

  /// Bawa status ke tahap "ada pembaruan yang tersedia" dengan versi dan catatan.
  fn ke_tersedia_dengan(status: &mut Status, versi: &str, catatan: Option<&str>) {
    terapkan(status, &Peristiwa::MulaiPeriksa { waktu: 1 });
    terapkan(
      status,
      &Peristiwa::SelesaiPeriksa {
        waktu: 2,
        versi: Some(versi.to_string()),
        catatan: catatan.map(|nilai| nilai.to_string()),
        tanggal: None,
      },
    );
  }

  #[test]
  fn bawaan_pengaturan_memakai_kanal_sesuai_versi_dan_otomatis() {
    let bawaan = pengaturan_bawaan();
    assert!(bawaan.auto_check);
    assert_eq!(
      bawaan.channel,
      kanal_bawaan_untuk(env!("CARGO_PKG_VERSION"))
    );
  }

  #[test]
  fn kanal_bawaan_versi_pra_rilis_memakai_beta() {
    assert_eq!(kanal_bawaan_untuk("0.1.0-beta.4"), KANAL_BETA);
    assert_eq!(kanal_bawaan_untuk("1.0.0-rc.1"), KANAL_BETA);
  }

  #[test]
  fn kanal_bawaan_versi_rilis_penuh_memakai_stabil() {
    assert_eq!(kanal_bawaan_untuk("1.0.0"), KANAL_STABIL);
    assert_eq!(kanal_bawaan_untuk("0.1.0"), KANAL_STABIL);
  }

  #[test]
  fn bawaan_versi_sekarang_memakai_kanal_beta() {
    // Rilis Jejak sekarang berupa pra-rilis, jadi bawaannya kanal beta.
    assert_eq!(kanal_bawaan_untuk(env!("CARGO_PKG_VERSION")), KANAL_BETA);
  }

  #[test]
  fn parse_pengaturan_membaca_berkas_lengkap() {
    let hasil = parse_pengaturan(r#"{"autoCheck": false, "channel": "beta"}"#).unwrap();
    assert_eq!(
      hasil,
      Pengaturan {
        auto_check: false,
        channel: KANAL_BETA.to_string(),
      }
    );
  }

  #[test]
  fn parse_pengaturan_menolak_kanal_tak_sah() {
    let galat = parse_pengaturan(r#"{"autoCheck": true, "channel": "nightly"}"#).unwrap_err();
    assert_eq!(galat, "kanal pembaruan tak dikenal");
  }

  #[test]
  fn parse_pengaturan_menolak_teks_rusak() {
    assert!(parse_pengaturan("bukan json").is_err());
  }

  #[test]
  fn parse_pengaturan_memakai_bawaan_bila_field_hilang() {
    let hasil = parse_pengaturan("{}").unwrap();
    assert!(hasil.auto_check);
    assert_eq!(hasil.channel, kanal_bawaan_untuk(env!("CARGO_PKG_VERSION")));
  }

  #[test]
  fn serialize_pengaturan_bolak_balik() {
    let pengaturan = Pengaturan {
      auto_check: false,
      channel: KANAL_BETA.to_string(),
    };
    let teks = serialize_pengaturan(&pengaturan).unwrap();
    assert!(teks.contains("autoCheck"));
    assert_eq!(parse_pengaturan(&teks).unwrap(), pengaturan);
  }

  #[test]
  fn berkas_hilang_memakai_bawaan() {
    let path = std::path::Path::new("/tmp/jejak-tidak-ada-desktop.json");
    assert_eq!(muat_pengaturan(path), pengaturan_bawaan());
  }

  #[test]
  fn berkas_rusak_memakai_bawaan() {
    let path = std::env::temp_dir().join(format!("jejak-rusak-{}.json", std::process::id()));
    std::fs::write(&path, "{ ini rusak").unwrap();
    assert_eq!(muat_pengaturan(&path), pengaturan_bawaan());
    std::fs::remove_file(&path).ok();
  }

  #[test]
  fn simpan_pengaturan_tulis_atomik_dan_baca_kembali() {
    let path = std::env::temp_dir().join(format!("jejak-atomic-{}/desktop.json", std::process::id()));
    let pengaturan = Pengaturan {
      auto_check: true,
      channel: KANAL_BETA.to_string(),
    };
    simpan_pengaturan(&path, &pengaturan).unwrap();
    assert_eq!(muat_pengaturan(&path), pengaturan);
    assert!(!path.with_extension("json.tmp").exists());
    std::fs::remove_dir_all(path.parent().unwrap()).ok();
  }

  #[test]
  fn transisi_memulai_pemeriksaan_dari_idle() {
    let mut status = Status::default();
    assert!(terapkan(
      &mut status,
      &Peristiwa::MulaiPeriksa { waktu: 100 }
    ));
    assert_eq!(status.state, Tahap::Checking);
    assert_eq!(status.last_check, Some(100));
  }

  #[test]
  fn transisi_menolak_pemeriksaan_ganda() {
    let mut status = Status::default();
    terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu: 100 });
    assert!(!terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu: 101 }));
    assert_eq!(status.state, Tahap::Checking);
  }

  #[test]
  fn transisi_pemeriksaan_selesai_tanpa_pembaruan() {
    let mut status = Status::default();
    terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu: 100 });
    assert!(terapkan(
      &mut status,
      &Peristiwa::SelesaiPeriksa {
        waktu: 120,
        versi: None,
        catatan: None,
        tanggal: None,
      }
    ));
    assert_eq!(status.state, Tahap::Idle);
    assert_eq!(status.version, None);
    assert_eq!(status.last_check, Some(120));
  }

  #[test]
  fn transisi_pemeriksaan_selesai_dengan_pembaruan() {
    let mut status = Status::default();
    terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu: 100 });
    terapkan(
      &mut status,
      &Peristiwa::SelesaiPeriksa {
        waktu: 120,
        versi: Some("1.2.0".to_string()),
        catatan: Some("catatan".to_string()),
        tanggal: Some("2026-11-14".to_string()),
      },
    );
    assert_eq!(status.state, Tahap::Available);
    assert_eq!(status.version.as_deref(), Some("1.2.0"));
    assert_eq!(status.notes.as_deref(), Some("catatan"));
  }

  #[test]
  fn transisi_unduh_hanya_dari_tersedia() {
    let mut status = Status::default();
    assert!(!terapkan(&mut status, &Peristiwa::MulaiUnduh));
    ke_tersedia(&mut status);
    assert!(terapkan(&mut status, &Peristiwa::MulaiUnduh));
    assert_eq!(status.state, Tahap::Downloading);
  }

  #[test]
  fn transisi_progres_hanya_saat_mengunduh() {
    let mut status = Status::default();
    ke_tersedia(&mut status);
    terapkan(&mut status, &Peristiwa::MulaiUnduh);
    assert!(!terapkan(&mut status, &Peristiwa::MulaiUnduh));
    terapkan(
      &mut status,
      &Peristiwa::Progres {
        terunduh: 512,
        total: Some(1024),
      },
    );
    assert_eq!(status.downloaded, 512);
    assert_eq!(status.total, Some(1024));
    assert_eq!(status.state, Tahap::Downloading);
  }

  #[test]
  fn transisi_urutan_sampai_siap() {
    let mut status = Status::default();
    ke_tersedia(&mut status);
    terapkan(&mut status, &Peristiwa::MulaiUnduh);
    terapkan(&mut status, &Peristiwa::SelesaiUnduh);
    assert_eq!(status.state, Tahap::Installing);
    terapkan(&mut status, &Peristiwa::SelesaiPasang);
    assert_eq!(status.state, Tahap::Ready);
  }

  #[test]
  fn transisi_galat_menuju_tahap_error() {
    let mut status = Status::default();
    terapkan(&mut status, &Peristiwa::MulaiPeriksa { waktu: 100 });
    terapkan(
      &mut status,
      &Peristiwa::Gagal {
        waktu: 150,
        pesan: "pemeriksaan pembaruan gagal".to_string(),
      },
    );
    assert_eq!(status.state, Tahap::Error);
    assert_eq!(
      status.error.as_deref(),
      Some("pemeriksaan pembaruan gagal")
    );
    assert_eq!(status.last_check, Some(150));
  }

  #[test]
  fn transisi_buang_tertahan_mengosongkan_pembaruan() {
    let mut status = Status::default();
    ke_tersedia_dengan(&mut status, "2.0.0", Some("catatan"));
    assert_eq!(status.notes.as_deref(), Some("catatan"));
    assert!(terapkan(&mut status, &Peristiwa::BuangTertahan));
    assert_eq!(status.state, Tahap::Idle);
    assert_eq!(status.version, None);
    assert_eq!(status.notes, None);
  }

  #[test]
  fn transisi_buang_tertahan_tak_berubah_bila_tak_tersedia() {
    let mut status = Status::default();
    assert!(!terapkan(&mut status, &Peristiwa::BuangTertahan));
    assert_eq!(status.state, Tahap::Idle);
  }

  #[test]
  fn endpoint_pemilihan_per_kanal() {
    assert_eq!(endpoint_kanal(KANAL_STABIL), Some(ENDPOINT_STABIL));
    assert_eq!(endpoint_kanal(KANAL_BETA), Some(ENDPOINT_BETA));
    assert_eq!(endpoint_kanal("nightly"), None);
  }

  #[test]
  fn endpoint_override_hanya_saat_diberikan() {
    assert_eq!(
      endpoint_dengan_override(KANAL_STABIL, None).as_deref(),
      Some(ENDPOINT_STABIL)
    );
    assert_eq!(
      endpoint_dengan_override(KANAL_BETA, None).as_deref(),
      Some(ENDPOINT_BETA)
    );
    assert_eq!(
      endpoint_dengan_override(KANAL_STABIL, Some("http://127.0.0.1:9/x.json")).as_deref(),
      Some("http://127.0.0.1:9/x.json")
    );
    assert_eq!(endpoint_dengan_override("nightly", None), None);
  }

  #[test]
  fn endpoint_efektif_tanpa_env_memakai_bawaan() {
    assert_eq!(
      endpoint_efektif(KANAL_STABIL).as_deref(),
      Some(ENDPOINT_STABIL)
    );
    assert_eq!(endpoint_efektif(KANAL_BETA).as_deref(), Some(ENDPOINT_BETA));
    assert_eq!(endpoint_efektif("nightly"), None);
  }

  #[test]
  fn kanal_sah_menerima_hanya_stabil_dan_beta() {
    assert!(kanal_sah(KANAL_STABIL));
    assert!(kanal_sah(KANAL_BETA));
    assert!(!kanal_sah("nightly"));
    assert!(!kanal_sah(""));
  }

  #[test]
  fn galat_kanal_stabil_tanpa_manifest_jadi_pesan_ramah() {
    let pesan = pesan_galat_pemeriksaan(
      KANAL_STABIL,
      "Could not fetch a valid release JSON from the remote",
    );
    assert_eq!(pesan, PESAN_BELUM_ADA_RILIS_STABIL);
  }

  #[test]
  fn galat_404_di_kanal_stabil_jadi_pesan_ramah() {
    let pesan = pesan_galat_pemeriksaan(KANAL_STABIL, "Permintaan gagal: 404 Not Found");
    assert_eq!(pesan, PESAN_BELUM_ADA_RILIS_STABIL);
  }

  #[test]
  fn galat_lain_di_kanal_stabil_tetap_bawaan() {
    let pesan = pesan_galat_pemeriksaan(KANAL_STABIL, "error sending request for url");
    assert_eq!(pesan, "pemeriksaan pembaruan gagal: error sending request for url");
  }

  #[test]
  fn galat_kanal_beta_tetap_bawaan() {
    let pesan = pesan_galat_pemeriksaan(
      KANAL_BETA,
      "Could not fetch a valid release JSON from the remote",
    );
    assert_eq!(
      pesan,
      "pemeriksaan pembaruan gagal: Could not fetch a valid release JSON from the remote"
    );
  }
}
