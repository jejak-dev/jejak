//! Pembaru otomatis cangkang Linux: periksa manifest, unduh tar.gz, verifikasi minisign,
//! ekstrak ke folder kerja, validasi. Berkas aplikasi baru disalin ke folder aplikasi saat
//! mulai ulang (`UpdateService::prepare_restart`); Linux mengizinkan rename di atas biner
//! yang sedang berjalan, jadi tak perlu skrip bantu selain penunggu proses lama.
//!
//! Hanya terpasang-sendiri (tar.gz di folder yang bisa ditulis pengguna) yang bisa
//! memperbarui diri; pemasangan .deb di /usr/lib/jejak dilaporkan "tak bisa ditulis".

use crate::l10n::l;
use crate::manifest::{self, Manifest, Platform, Settings, SettingsStore};
use crate::minisign::PublicKey;
use crate::semver::Semver;
use crate::update_state::{Phase, Status};
use serde_json::Value;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX_DOWNLOAD: u64 = 1 << 30; // 1 GiB, pagar kewarasan
const MAX_MANIFEST: u64 = 2 << 20;

pub struct Config {
    pub current: Semver,
    /// Folder aplikasi yang sedang berjalan (tempat `Jejak` berada).
    pub install_dir: PathBuf,
    /// Folder kerja pembaruan (unduhan dan hasil ekstrak).
    pub work_dir: PathBuf,
    pub pubkey: String,
    pub platform_key: String,
    /// Mengubah kanal menjadi URL manifest; `None` = kanal tak dikenal.
    pub endpoint: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
    /// Izinkan skema non-https (hanya override debug dan tes).
    pub allow_insecure: bool,
}

struct Inner {
    status: Status,
    pending: Option<(Manifest, Platform)>,
    busy: bool,
    staged: Option<PathBuf>,
}

#[derive(Clone)]
pub struct Updater {
    cfg: Arc<Config>,
    inner: Arc<Mutex<Inner>>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Updater {
    pub fn new(cfg: Config) -> Updater {
        Updater {
            cfg: Arc::new(cfg),
            inner: Arc::new(Mutex::new(Inner { status: Status::default(), pending: None, busy: false, staged: None })),
        }
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    pub fn is_ready(&self) -> bool {
        self.status().state == Phase::Ready
    }

    pub fn staged_dir(&self) -> Option<PathBuf> {
        self.inner.lock().unwrap().staged.clone()
    }

    fn mutate(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.inner.lock().unwrap().status);
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
            .user_agent("Jejak-native")
            .build()
    }

    fn check_scheme(&self, url: &str) -> Result<(), String> {
        if self.cfg.allow_insecure || url.starts_with("https://") {
            Ok(())
        } else {
            Err(l("update.insecure", "alamat pembaruan harus https", &[]))
        }
    }

    fn get(&self, url: &str) -> Result<ureq::Response, String> {
        match Self::agent().get(url).call() {
            Ok(r) => Ok(r),
            Err(ureq::Error::Status(code, _)) => Err(l("update.http", "server pembaruan menjawab %@", &[&code.to_string()])),
            Err(e) => Err(e.to_string()),
        }
    }

    // ---- Periksa ----

    /// Memeriksa manifest kanal (memblokir); hanya satu pemeriksaan pada satu waktu.
    pub fn check(&self, channel: &str) -> Status {
        {
            let mut g = self.inner.lock().unwrap();
            if g.busy || !g.status.start_check(now()) {
                return g.status.clone();
            }
            g.busy = true;
        }
        let result = self.fetch_manifest(channel);
        let mut g = self.inner.lock().unwrap();
        g.busy = false;
        match result {
            Ok(found) => {
                let (v, n, d) = match &found {
                    Some((m, _)) => (Some(m.version.to_string()), m.notes.clone(), m.date.clone()),
                    None => (None, None, None),
                };
                g.pending = found;
                g.status.finish_check(now(), v, n, d);
            }
            Err(e) => g.status.fail(now(), e),
        }
        g.status.clone()
    }

    fn fetch_manifest(&self, channel: &str) -> Result<Option<(Manifest, Platform)>, String> {
        let url = (self.cfg.endpoint)(channel).ok_or_else(|| l("update.bad_channel", "kanal pembaruan tak dikenal", &[]))?;
        self.check_scheme(&url)?;
        let resp = match Self::agent().get(&url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(404, _)) if channel == manifest::STABLE => {
                return Err(l("update.no_stable", "Belum ada rilis stabil. Pilih kanal Beta di Pengaturan.", &[]));
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(l("update.http", "server pembaruan menjawab %@", &[&code.to_string()]));
            }
            Err(e) => return Err(e.to_string()),
        };
        let mut body = Vec::new();
        resp.into_reader().take(MAX_MANIFEST).read_to_end(&mut body).map_err(|e| e.to_string())?;
        let m = Manifest::parse(&body)?;
        if m.version <= self.cfg.current {
            return Ok(None); // terbaru
        }
        match m.platforms.get(&self.cfg.platform_key).cloned() {
            Some(p) => Ok(Some((m, p))),
            None => Ok(None), // belum ada artefak native untuk platform ini
        }
    }

    /// Membuang pembaruan tertahan (mis. saat kanal berganti).
    pub fn discard_pending(&self) {
        let mut g = self.inner.lock().unwrap();
        g.pending = None;
        g.status.drop_pending();
    }

    // ---- Pasang ----

    /// Memulai unduh+siapkan di latar belakang; pantau lewat `status()`.
    pub fn install(&self) -> Result<Status, String> {
        let (manifest, platform, snapshot) = {
            let mut g = self.inner.lock().unwrap();
            if g.busy {
                return Err(l("update.busy", "pemasangan pembaruan sedang berjalan", &[]));
            }
            if g.pending.is_none() || !g.status.start_download() {
                return Err(l("update.none", "belum ada pembaruan untuk dipasang", &[]));
            }
            let (m, p) = g.pending.take().unwrap();
            g.busy = true;
            (m, p, g.status.clone())
        };
        let me = self.clone();
        std::thread::spawn(move || {
            let result = me.stage(&manifest, &platform);
            let mut g = me.inner.lock().unwrap();
            g.busy = false;
            match result {
                Ok(dir) => {
                    g.staged = Some(dir);
                    g.status.finish_install();
                }
                Err(e) => g.status.fail(now(), e),
            }
        });
        Ok(snapshot)
    }

    fn stage(&self, manifest: &Manifest, platform: &Platform) -> Result<PathBuf, String> {
        self.check_scheme(&platform.url)?;
        ensure_writable(&self.cfg.install_dir)?;
        clean_dir_contents(&self.cfg.work_dir);
        let work = self.cfg.work_dir.join(format!("u{}-{}", std::process::id(), now()));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let result = self.stage_in(&work, manifest, platform);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&work);
        }
        result
    }

    fn stage_in(&self, work: &Path, manifest: &Manifest, platform: &Platform) -> Result<PathBuf, String> {
        let archive = work.join("update.tar.gz");
        self.download(&platform.url, &archive)?;
        self.mutate(|s| {
            s.finish_download();
        });

        // Verifikasi SEBELUM menyentuh isi arsip.
        PublicKey::from_base64(&self.cfg.pubkey)?.verify_file(&archive, &platform.signature)?;

        let extracted = work.join("x");
        extract_safely(&archive, &extracted)?;
        let root = find_app_root(&extracted)?;
        validate(&root, &manifest.version)?;
        let _ = std::fs::remove_file(&archive);
        Ok(root)
    }

    fn download(&self, url: &str, dest: &Path) -> Result<(), String> {
        let resp = self.get(url)?;
        let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok());
        if total.map(|t| t > MAX_DOWNLOAD).unwrap_or(false) {
            return Err(l("update.too_large", "unduhan pembaruan terlalu besar", &[]));
        }
        let mut reader = resp.into_reader();
        let mut out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut got: u64 = 0;
        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            if got > MAX_DOWNLOAD {
                return Err(l("update.too_large", "unduhan pembaruan terlalu besar", &[]));
            }
            self.mutate(|s| {
                s.progress(got, total.filter(|t| *t > 0));
            });
        }
        Ok(())
    }
}

/// Gagal lebih awal bila folder aplikasi tak bisa ditulis (mis. /usr/lib/jejak dari .deb).
pub fn ensure_writable(dir: &Path) -> Result<(), String> {
    let probe = dir.join(format!(".jejak-write-test-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(_) => Err(l("update.not_writable", "folder aplikasi tak bisa ditulis: %@", &[&dir.to_string_lossy()])),
    }
}

fn clean_dir_contents(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
    }
}

/// Ekstrak tar.gz hanya untuk berkas biasa dan folder, dengan jalur relatif tanpa `..`.
pub fn extract_safely(archive: &Path, dest: &Path) -> Result<(), String> {
    let bad = || l("update.bad_archive", "arsip pembaruan tak sah", &[]);
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut total: u64 = 0;
    for entry in tar.entries().map_err(|_| bad())? {
        let mut entry = entry.map_err(|_| bad())?;
        let kind = entry.header().entry_type();
        let rel = entry.path().map_err(|_| bad())?.into_owned();
        if !rel.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
            return Err(bad());
        }
        let target = dest.join(&rel);
        if kind.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else if kind.is_file() {
            total += entry.header().size().unwrap_or(0);
            if total > 2 * MAX_DOWNLOAD {
                return Err(l("update.too_large", "unduhan pembaruan terlalu besar", &[]));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        } else {
            return Err(bad()); // symlink, perangkat, dst. tak diterima
        }
    }
    Ok(())
}

const EXE: &str = "Jejak";
const SIDECAR: &str = "jejak-server";

/// Akar aplikasi: folder hasil ekstrak sendiri, atau satu-satunya subfolder (`Jejak/`).
fn find_app_root(extracted: &Path) -> Result<PathBuf, String> {
    if extracted.join(EXE).is_file() {
        return Ok(extracted.to_path_buf());
    }
    let subs: Vec<PathBuf> =
        std::fs::read_dir(extracted).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    if subs.len() == 1 && subs[0].join(EXE).is_file() {
        return Ok(subs[0].clone());
    }
    Err(l("update.wrong_app", "arsip pembaruan bukan aplikasi Jejak native", &[]))
}

fn validate(root: &Path, expected: &Semver) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if !root.join(SIDECAR).is_file() {
        return Err(l("update.bad_app", "aplikasi pembaruan tak sah", &[]));
    }
    let version = std::fs::read_to_string(root.join("VERSION")).ok().and_then(|t| Semver::parse(&t));
    if version.as_ref() != Some(expected) {
        return Err(l("update.version_mismatch", "versi aplikasi di arsip tak sesuai manifest", &[]));
    }
    // Mode ditetapkan sendiri, tak bergantung pada isi arsip.
    for (name, mode) in [(EXE, 0o755), (SIDECAR, 0o755)] {
        std::fs::set_permissions(root.join(name), std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Menyalin hasil ekstrak ke folder aplikasi. Tiap berkas ditulis ke nama sementara lalu
/// di-rename di atas tujuan (atomik; aman untuk biner yang sedang berjalan).
pub fn apply(staged: &Path, install_dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fn walk(dir: &Path, rel: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let r = rel.join(e.file_name());
            if e.file_type()?.is_dir() {
                walk(&e.path(), &r, out)?;
            } else {
                out.push(r);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(staged, Path::new(""), &mut files).map_err(|e| e.to_string())?;
    for rel in files {
        let src = staged.join(&rel);
        let dst = install_dir.join(&rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let tmp = dst.with_file_name(format!(".{}.jejak-new", dst.file_name().unwrap().to_string_lossy()));
        std::fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
        let mode = std::fs::metadata(&src).map_err(|e| e.to_string())?.permissions().mode() & 0o777;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &dst).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
    }
    Ok(())
}

/// Perintah `sh` yang menunggu proses lama keluar lalu menjalankan biner baru.
pub fn relaunch_args(pid: u32, exe: &Path) -> Vec<String> {
    vec![
        "-c".into(),
        "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec \"$2\"".into(),
        "sh".into(),
        pid.to_string(),
        exe.to_string_lossy().into_owned(),
    ]
}

// ---- Layanan: pengaturan tersimpan + jadwal + mulai ulang ----

pub struct UpdateService {
    updater: Option<Updater>,
    store: SettingsStore,
    settings: Mutex<Settings>,
    install_dir: PathBuf,
}

impl UpdateService {
    /// Layanan produksi: kunci tertanam saat build (atau override debug), folder dari XDG.
    pub fn from_env(version: &str) -> UpdateService {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let data = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(&home).join(".local/share")).join("jejak");
        let debug = std::env::var("JEJAK_DEBUG").map(|v| v == "1").unwrap_or(false);
        let key = debug
            .then(|| std::env::var("JEJAK_UPDATE_PUBKEY").ok())
            .flatten()
            .or_else(|| option_env!("JEJAK_UPDATE_PUBKEY").map(str::to_string));
        let install_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
        let over = debug.then(|| std::env::var("JEJAK_UPDATE_ENDPOINT").ok().filter(|v| !v.is_empty())).flatten();
        let updater = match (key, Semver::parse(version)) {
            (Some(key), Some(current)) if !key.is_empty() => {
                let over2 = over.clone();
                Some(Updater::new(Config {
                    current,
                    install_dir: install_dir.clone(),
                    work_dir: data.join("update"),
                    pubkey: key,
                    platform_key: manifest::native_platform_key().to_string(),
                    endpoint: Box::new(move |ch| match &over2 {
                        Some(u) => Some(u.clone()),
                        None => manifest::endpoint(ch).map(str::to_string),
                    }),
                    allow_insecure: over.is_some(),
                }))
            }
            _ => None,
        };
        Self::new(updater, SettingsStore::new(data.join("updater.json"), version), install_dir)
    }

    pub fn new(updater: Option<Updater>, store: SettingsStore, install_dir: PathBuf) -> UpdateService {
        let settings = Mutex::new(store.load());
        UpdateService { updater, store, settings, install_dir }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn apply_settings(&self, next: Settings) -> Result<(), String> {
        if !manifest::is_valid_channel(&next.channel) {
            return Err(l("update.bad_channel", "kanal pembaruan tak dikenal", &[]));
        }
        let changed = next.channel != self.settings().channel;
        self.store.save(&next)?;
        *self.settings.lock().unwrap() = next;
        if changed {
            if let Some(u) = &self.updater {
                u.discard_pending();
            }
        }
        Ok(())
    }

    pub fn status_json(&self) -> Value {
        self.updater.as_ref().map(|u| u.status()).unwrap_or_default().to_json()
    }

    /// Memblokir sampai pemeriksaan selesai; panggil dari thread latar.
    pub fn check(&self) -> Value {
        match &self.updater {
            Some(u) => u.check(&self.settings().channel).to_json(),
            None => Status::default().to_json(),
        }
    }

    pub fn install(&self) -> Result<Value, String> {
        let u = self.updater.as_ref().ok_or_else(|| l("update.unavailable", "pembaruan otomatis tak tersedia pada build ini", &[]))?;
        u.install().map(|s| s.to_json())
    }

    /// Menyalin berkas baru ke folder aplikasi dan memulai penunggu yang menjalankan biner
    /// baru setelah proses ini keluar. Pemanggil harus segera menutup aplikasi.
    pub fn prepare_restart(&self) -> Result<(), String> {
        let not_ready = || l("update.not_ready", "belum ada pembaruan siap dijalankan", &[]);
        let u = self.updater.as_ref().ok_or_else(not_ready)?;
        let staged = if u.is_ready() { u.staged_dir() } else { None }.ok_or_else(not_ready)?;
        // Dihitung SEBELUM menyalin: setelah rename, /proc/self/exe menjadi "… (deleted)".
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = self.install_dir.join(exe.file_name().ok_or_else(not_ready)?);
        apply(&staged, &self.install_dir)?;
        if let Some(work) = staged.ancestors().find(|a| a.parent().map(|p| p.ends_with("update")).unwrap_or(false)) {
            let _ = std::fs::remove_dir_all(work);
        }
        std::process::Command::new("sh")
            .args(relaunch_args(std::process::id(), &exe))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Sekali setelah mulai (15 dtk), lalu tiap enam jam; menghormati `auto_check`.
    pub fn start_auto_check(self: &Arc<Self>) {
        if self.updater.is_none() {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(15));
            loop {
                if me.settings().auto_check {
                    me.check();
                }
                std::thread::sleep(Duration::from_secs(6 * 3600));
            }
        });
    }
}
