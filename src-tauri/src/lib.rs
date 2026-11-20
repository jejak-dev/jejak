//! Cangkang desktop Jejak (Tauri v2).
//!
//! Cangkang ini menjalankan sidecar `jejak serve --desktop` lalu menampilkan
//! antarmukanya di satu jendela webview. Token masuk sekali pakai hanya hidup
//! di memori proses ini dan tak pernah dicetak ke log.

mod sidecar;
mod token;
mod updater;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Label jendela utama.
const NAMA_JENDELA: &str = "main";

/// Shim notifikasi native yang disuntik ke jendela utama.
const SHIM_NOTIFIKASI: &str = include_str!("../shim/notification.js");

/// Batas waktu menunggu pengumuman server siap.
const JEJAK_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Jumlah baris stderr terakhir yang disimpan untuk ringkasan galat.
const BATAS_BARIS_STDERR: usize = 200;

/// Batas waktu menunggu sidecar keluar setelah stdin ditutup.
const JEDA_KELUAR: Duration = Duration::from_secs(3);

/// Galat yang menunggu halaman lokal selesai dimuat untuk ditampilkan.
#[derive(Clone, Debug)]
struct Galat {
  judul: String,
  rincian: String,
}

/// Proses sidecar yang sedang berjalan.
struct ProsesSidecar {
  child: Child,
  stdin: Option<ChildStdin>,
}

/// Status bersama antar utas.
struct Status {
  /// Sidecar yang sedang berjalan; `None` bila belum mulai atau sudah ditutup.
  proses: Mutex<Option<ProsesSidecar>>,
  /// Port server sidecar; 0 berarti belum diketahui.
  port: AtomicU16,
  /// Set ketika aplikasi sendiri yang menutup sidecar (bukan kegagalan).
  ditutup: AtomicBool,
  /// Galat yang menunggu halaman lokal selesai dimuat.
  galat_tunggu: Mutex<Option<Galat>>,
  /// Ring buffer baris stderr terakhir dari sidecar.
  stderr_buf: Arc<Mutex<VecDeque<String>>>,
}

/// Peristiwa dari thread pembaca stdout sidecar.
enum Peristiwa {
  /// Server sudah siap; membawa port yang dipakai.
  Siap(sidecar::ReadyInfo),
  /// Baris penguman rusak.
  Galat(String),
  /// stdout sidecar tertutup: proses selesai (atau mati).
  Selesai,
}

/// Titik masuk aplikasi desktop Jejak.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let aplikasi = tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      // Luncuran kedua: fokuskan jendela yang sudah ada.
      if let Some(window) = app.get_webview_window(NAMA_JENDELA) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_notification::init())
    // Skrip klik bawaan opener memanggil IPC yang tak diizinkan untuk halaman
    // loopback dan membatalkan klik, sehingga `on_new_window` tak pernah jalan.
    // Dimatikan: tautan web ditangani `on_navigation` dan `on_new_window`.
    .plugin(
      tauri_plugin_opener::Builder::new()
        .open_js_links_on_click(false)
        .build(),
    )
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      updater::desktop_info,
      updater::updater_get_settings,
      updater::updater_set_settings,
      updater::updater_check,
      updater::updater_status,
      updater::updater_install,
      updater::updater_restart,
    ])
    .setup(|app| {
      let _ = app.manage(Status {
        proses: Mutex::new(None),
        port: AtomicU16::new(0),
        ditutup: AtomicBool::new(false),
        galat_tunggu: Mutex::new(None),
        stderr_buf: Arc::new(Mutex::new(VecDeque::new())),
      });
      // Pengaturan pembaruan disimpan di folder konfigurasi aplikasi.
      let folder = app
        .path()
        .app_config_dir()
        .map_err(|galat| format!("folder konfigurasi tak bisa ditentukan: {galat}"))?;
      let _ = app.manage(updater::UpdaterState::baru(folder.join(updater::NAMA_BERKAS)));
      buat_jendela(app.handle())?;
      // Sidecar dijalankan di utas terpisah supaya setup tak terblokir.
      let handle = app.handle().clone();
      std::thread::spawn(move || jalankan_sidecar(handle));
      // Pemeriksaan pembaruan otomatis berjalan di latar belakang.
      updater::jalankan_pemeriksaan_otomatis(app.handle().clone());
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("gagal membangun aplikasi desktop Jejak");

  aplikasi.run(|handle, event| match event {
    RunEvent::WindowEvent {
      label,
      event: WindowEvent::CloseRequested { .. },
      ..
    } => {
      // Menutup jendela utama = keluar aplikasi (supaya server ikut mati).
      if label == NAMA_JENDELA {
        handle.exit(0);
      }
    }
    RunEvent::ExitRequested { .. } | RunEvent::Exit => {
      hentikan_sidecar(handle);
    }
    _ => {}
  });
}

/// Buat jendela utama yang memuat splash lokal.
fn buat_jendela(app: &AppHandle) -> tauri::Result<()> {
  let handle_navigasi = app.clone();
  let handle_jendela_baru = app.clone();
  WebviewWindowBuilder::new(app, NAMA_JENDELA, WebviewUrl::App("index.html".into()))
    .title("Jejak")
    .inner_size(1280.0, 820.0)
    .min_inner_size(900.0, 600.0)
    .center()
    // Penangan drag-drop bawaan Tauri menyadap drop dari OS sehingga event
    // dragover/drop tak sampai ke halaman; drop berkas ditangani HTML5 di web.
    .disable_drag_drop_handler()
    // WKWebView tak punya API notifikasi; shim ini menggantinya dengan
    // kelas yang menembak plugin notifikasi Tauri.
    .initialization_script(SHIM_NOTIFIKASI)
    // Hanya halaman lokal dan server Jejak di loopback yang boleh dimuat.
    .on_navigation(move |url| {
      let port = handle_navigasi.state::<Status>().port.load(Ordering::SeqCst);
      if sidecar::is_allowed_navigation(url.as_str(), port) {
        return true;
      }
      // Navigasi ditolak: tautan web dialihkan ke browser sistem.
      if let Some(target) = sidecar::external_open_target(url.as_str(), port) {
        buka_di_browser(&handle_navigasi, &target);
      }
      false
    })
    // Jendela baru (mis. `target=_blank`) tak pernah dibuka; tautan web
    // dialihkan ke browser sistem.
    .on_new_window(move |url, _features| {
      let port = handle_jendela_baru.state::<Status>().port.load(Ordering::SeqCst);
      if let Some(target) = sidecar::external_open_target(url.as_str(), port) {
        buka_di_browser(&handle_jendela_baru, &target);
      }
      tauri::webview::NewWindowResponse::Deny
    })
    // Setelah halaman lokal selesai dimuat, tampilkan galat yang tertunda.
    .on_page_load(move |window, payload| {
      if payload.event() != PageLoadEvent::Finished {
        return;
      }
      if !sidecar::is_local_app_url(payload.url().as_str()) {
        return;
      }
      let state = window.app_handle().state::<Status>();
      let Some(galat) = state.galat_tunggu.lock().unwrap().take() else {
        return;
      };
      let _ = window.eval(skrip_galat(&galat.judul, &galat.rincian));
    })
    .build()?;
  Ok(())
}

/// Buka URL di browser sistem; galat tak menggagalkan navigasi.
fn buka_di_browser(app: &AppHandle, url: &str) {
  use tauri_plugin_opener::OpenerExt;
  if let Err(galat) = app.opener().open_url(url, None::<String>) {
    eprintln!("gagal membuka {url} di browser: {galat}");
  }
}

/// Cari binary sidecar: env `JEJAK_SIDECAR`, lalu dekat binary aplikasi.
fn cari_binary_sidecar() -> Result<PathBuf, String> {
  if let Ok(nilai) = std::env::var("JEJAK_SIDECAR") {
    let path = PathBuf::from(nilai);
    if path.is_file() {
      return Ok(path);
    }
    return Err(format!(
      "JEJAK_SIDECAR menunjuk berkas yang tak ada: {}",
      path.display()
    ));
  }
  let exe = std::env::current_exe()
    .map_err(|galat| format!("tak bisa menentukan lokasi aplikasi: {galat}"))?;
  let folder = exe
    .parent()
    .ok_or_else(|| "lokasi aplikasi tak punya folder induk".to_string())?
    .to_path_buf();
  let nama = if cfg!(windows) { "jejak.exe" } else { "jejak" };
  let mut kandidat: Vec<PathBuf> = vec![folder.join(nama)];
  if let Some(triple) = sidecar::triple_platform() {
    kandidat.push(folder.join(format!("jejak-{triple}")));
    kandidat.push(folder.join(format!("jejak-{triple}.exe")));
  }
  kandidat.push(folder.join("binaries").join(nama));
  kandidat.push(
    folder
      .join("..")
      .join("Resources")
      .join("binaries")
      .join(nama),
  );
  for path in &kandidat {
    if path.is_file() {
      return Ok(path.clone());
    }
  }
  Err(format!(
    "binary sidecar tak ditemukan. Dicoba: {}",
    kandidat
      .iter()
      .map(|path| path.display().to_string())
      .collect::<Vec<_>>()
      .join(", ")
  ))
}

/// Jalankan sidecar di utas terpisah lalu tunggu pengumuman server siap.
fn jalankan_sidecar(app: AppHandle) {
  let path = match cari_binary_sidecar() {
    Ok(path) => path,
    Err(galat) => {
      tampilkan_galat(&app, "Jejak tak bisa dimulai", &galat);
      return;
    }
  };
  let token = match token::generate_token() {
    Ok(token) if token::token_sah(&token) => token,
    Ok(_) => {
      tampilkan_galat(
        &app,
        "Jejak tak bisa dimulai",
        "token masuk yang dibuat tak memenuhi syarat server.",
      );
      return;
    }
    Err(galat) => {
      tampilkan_galat(&app, "Jejak tak bisa dimulai", &galat);
      return;
    }
  };

  let mut perintah = Command::new(&path);
  perintah.args(["serve", "--desktop"]);
  perintah.env("JEJAK_DESKTOP_TOKEN", &token);
  // Port 0 = acak; menguncinya mencegah PORT dari lingkungan induk menimpa.
  perintah.env("PORT", "0");
  perintah
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    // 0x08000000 = CREATE_NO_WINDOW.
    perintah.creation_flags(0x0800_0000);
  }

  let mut child = match perintah.spawn() {
    Ok(child) => child,
    Err(galat) => {
      tampilkan_galat(
        &app,
        "Jejak tak bisa dimulai",
        &format!("gagal menjalankan sidecar {}: {galat}", path.display()),
      );
      return;
    }
  };
  // Lepaskan `Command` supaya salinan token di lingkungannya tak tertahan.
  drop(perintah);
  let stdin = child.stdin.take();
  let Some(stdout) = child.stdout.take() else {
    tampilkan_galat(&app, "Jejak tak bisa dimulai", "sidecar tak memberi stdout");
    return;
  };
  let Some(stderr) = child.stderr.take() else {
    tampilkan_galat(&app, "Jejak tak bisa dimulai", "sidecar tak memberi stderr");
    return;
  };

  let (tx, rx) = channel::<Peristiwa>();
  let stderr_buf = Arc::clone(&app.state::<Status>().stderr_buf);
  let buf_thread = Arc::clone(&stderr_buf);
  std::thread::spawn(move || baca_stderr(stderr, buf_thread));
  let tx_stdout = tx.clone();
  std::thread::spawn(move || baca_stdout(stdout, tx_stdout));

  {
    let state = app.state::<Status>();
    let mut guard = state.proses.lock().unwrap();
    *guard = Some(ProsesSidecar { child, stdin });
  }

  tunggu_sidecar(app, rx, token, stderr_buf);
}

/// Baca stdout sidecar per baris; kirim pengumuman siap sekali lalu terus
/// menguras pipa supaya sidecar tak terblokir menulis.
fn baca_stdout(stdout: std::process::ChildStdout, tx: Sender<Peristiwa>) {
  let reader = BufReader::new(stdout);
  let mut sudah_siap = false;
  for baris in reader.lines() {
    let Ok(baris) = baris else { break };
    if sudah_siap {
      continue;
    }
    match sidecar::parse_ready_line(&baris) {
      Ok(Some(info)) => {
        sudah_siap = true;
        if tx.send(Peristiwa::Siap(info)).is_err() {
          return;
        }
      }
      Ok(None) => {}
      Err(galat) => {
        let _ = tx.send(Peristiwa::Galat(galat));
        return;
      }
    }
  }
  let _ = tx.send(Peristiwa::Selesai);
}

/// Baca stderr sidecar dan simpan 200 baris terakhir.
fn baca_stderr(stderr: std::process::ChildStderr, buffer: Arc<Mutex<VecDeque<String>>>) {
  let reader = BufReader::new(stderr);
  for baris in reader.lines() {
    let Ok(baris) = baris else { break };
    let mut guard = buffer.lock().unwrap();
    if guard.len() >= BATAS_BARIS_STDERR {
      guard.pop_front();
    }
    guard.push_back(baris);
  }
}

/// Tunggu server siap, lalu arahkan jendela ke URL masuk sekali pakai.
fn tunggu_sidecar(
  app: AppHandle,
  rx: Receiver<Peristiwa>,
  mut token: String,
  stderr_buf: Arc<Mutex<VecDeque<String>>>,
) {
  let info = match rx.recv_timeout(JEJAK_READY_TIMEOUT) {
    Ok(Peristiwa::Siap(info)) => info,
    Ok(Peristiwa::Galat(galat)) => {
      gagal(
        &app,
        "Server Jejak gagal dimulai",
        &format!("{galat}\n{}", ringkasan_stderr(&stderr_buf)),
      );
      return;
    }
    Ok(Peristiwa::Selesai) => {
      gagal(
        &app,
        "Server Jejak berhenti sebelum siap",
        &ringkasan_stderr(&stderr_buf),
      );
      return;
    }
    Err(RecvTimeoutError::Timeout) => {
      gagal(
        &app,
        "Server Jejak tak siap dalam 30 detik",
        &ringkasan_stderr(&stderr_buf),
      );
      return;
    }
    Err(RecvTimeoutError::Disconnected) => {
      gagal(
        &app,
        "Server Jejak tak bisa dipantau",
        &ringkasan_stderr(&stderr_buf),
      );
      return;
    }
  };

  {
    let state = app.state::<Status>();
    state.port.store(info.port, Ordering::SeqCst);
  }
  let Some(window) = app.get_webview_window(NAMA_JENDELA) else {
    return;
  };
  let url_teks = sidecar::enter_url(info.port, &token);
  let url = match tauri::Url::parse(&url_teks) {
    Ok(url) => url,
    Err(galat) => {
      gagal(
        &app,
        "Gagal membuka Jejak",
        &format!("URL masuk tak valid: {galat}\n{}", ringkasan_stderr(&stderr_buf)),
      );
      return;
    }
  };
  if let Err(galat) = window.navigate(url) {
    gagal(
      &app,
      "Gagal membuka Jejak",
      &format!("{galat}\n{}", ringkasan_stderr(&stderr_buf)),
    );
    return;
  }
  // Token tak dibutuhkan lagi; buang dari memori.
  token::wipe(&mut token);
  drop(url_teks);

  // Pantau: sidecar keluar tak terduga setelah siap.
  loop {
    match rx.recv() {
      Ok(Peristiwa::Selesai) => {
        if app.state::<Status>().ditutup.load(Ordering::SeqCst) {
          return;
        }
        gagal(
          &app,
          "Server Jejak berhenti",
          &ringkasan_stderr(&stderr_buf),
        );
        return;
      }
      Ok(Peristiwa::Galat(galat)) => {
        gagal(
          &app,
          "Server Jejak gagal",
          &format!("{galat}\n{}", ringkasan_stderr(&stderr_buf)),
        );
        return;
      }
      Ok(Peristiwa::Siap(_)) => {}
      Err(_) => return,
    }
  }
}

/// Kegagalan: matikan sidecar lalu tampilkan layar galat.
fn gagal(app: &AppHandle, judul: &str, rincian: &str) {
  {
    let state = app.state::<Status>();
    state.ditutup.store(true, Ordering::SeqCst);
    let mut guard = state.proses.lock().unwrap();
    if let Some(mut proses) = guard.take() {
      drop(proses.stdin.take());
      let _ = proses.child.kill();
      let _ = proses.child.wait();
    }
  }
  tampilkan_galat(app, judul, rincian);
}

/// Tampilkan layar galat di jendela utama.
fn tampilkan_galat(app: &AppHandle, judul: &str, rincian: &str) {
  let Some(window) = app.get_webview_window(NAMA_JENDELA) else {
    return;
  };
  let galat = Galat {
    judul: judul.to_string(),
    rincian: rincian.to_string(),
  };
  let sudah_lokal = window
    .url()
    .map(|url| sidecar::is_local_app_url(url.as_str()))
    .unwrap_or(false);
  if sudah_lokal {
    // Halaman lokal sudah tampil; cukup panggil penampil galat.
    let _ = window.eval(skrip_galat(&galat.judul, &galat.rincian));
    return;
  }
  // Kembali ke halaman lokal dulu; galat dikirim setelah halaman dimuat.
  let state = app.state::<Status>();
  *state.galat_tunggu.lock().unwrap() = Some(galat);
  let _ = window.navigate(sidecar::app_url("index.html"));
}

/// Skrip JS yang memanggil `window.__jejakGalat` dengan argumen aman.
fn skrip_galat(judul: &str, rincian: &str) -> String {
  let judul_json = serde_json::to_string(judul).unwrap_or_else(|_| "\"Galat\"".to_string());
  let rincian_json = serde_json::to_string(rincian).unwrap_or_else(|_| "\"\"".to_string());
  format!(
    "(function(){{function coba(){{if(typeof window.__jejakGalat === 'function'){{window.__jejakGalat({judul_json},{rincian_json});}}else{{setTimeout(coba,50);}}}}coba();}})();"
  )
}

/// Ringkasan 200 baris stderr terakhir untuk layar galat.
fn ringkasan_stderr(buffer: &Arc<Mutex<VecDeque<String>>>) -> String {
  let guard = buffer.lock().unwrap();
  if guard.is_empty() {
    return "Tak ada keluaran galat dari server.".to_string();
  }
  guard.iter().cloned().collect::<Vec<_>>().join("\n")
}

/// Tutup sidecar: tutup stdin (sinyal berhenti), tunggu, lalu paksa bunuh.
pub(crate) fn hentikan_sidecar(app: &AppHandle) {
  let state = app.state::<Status>();
  state.ditutup.store(true, Ordering::SeqCst);
  let mut guard = state.proses.lock().unwrap();
  let Some(mut proses) = guard.take() else {
    return;
  };
  drop(proses.stdin.take());
  let batas = Instant::now() + JEDA_KELUAR;
  loop {
    match proses.child.try_wait() {
      Ok(Some(_)) => return,
      Ok(None) => {
        if Instant::now() >= batas {
          let _ = proses.child.kill();
          let _ = proses.child.wait();
          return;
        }
        std::thread::sleep(Duration::from_millis(50));
      }
      Err(_) => {
        let _ = proses.child.kill();
        return;
      }
    }
  }
}
