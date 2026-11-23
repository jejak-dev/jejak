use base64::{engine::general_purpose::STANDARD, Engine};
use blake2::{Blake2b512, Digest};
use ed25519_dalek::{Signer, SigningKey};
use jejak_desktop::manifest::{self, Manifest, Settings, SettingsStore};
use jejak_desktop::minisign::PublicKey;
use jejak_desktop::semver::Semver;
use jejak_desktop::update_state::{Phase, Status};
use jejak_desktop::updater::{self, Config, Updater};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// Fixture: kunci uji sekali pakai + berkas "hello-update\n" yang ditandatangani `tauri signer` (varian ED).
const KUNCI_UJI: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhCQTI4NEEwRjgwNDAyRkIKUldUN0FnVDRvSVNpaXdtZFZUckcxU0NvT05LeVorbERaVEF6YlFXWCtIWVJkVDh1YjVTMGlxanQK";
const SIG_UJI: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUN0FnVDRvSVNpaXdZeG53K1VpTlB2aCtSM3JMT3pYejdnL2w4VHNwR3haYlR0c0s2K0tVbzlDd0RmcmN4OHJzdmx6Skl4STA2YlpVNUpsRk5zUmJibjRkZ0N0d1lWZkFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NDE0MzYzCWZpbGU6YS5iaW4Kc0c0cFZUU0F5ZHBGM0M1Sm1STnhHZXZJWmh5dzBLa0sxN24zZUFkdVFWRitiVmJnYVYxVmpDRDVnMy9tMXF2MG1qU1BMNTMvTUpOUEtEZEdoUm1UQ3c9PQo=";
const HELLO: &[u8] = b"hello-update\n";

struct TestSigner {
    key: SigningKey,
    key_id: [u8; 8],
}

impl TestSigner {
    fn new(seed: u8) -> Self {
        TestSigner { key: SigningKey::from_bytes(&[seed; 32]), key_id: [seed; 8] }
    }
    fn pubkey(&self) -> String {
        let mut raw = vec![0x45, 0x64];
        raw.extend_from_slice(&self.key_id);
        raw.extend_from_slice(self.key.verifying_key().as_bytes());
        STANDARD.encode(format!("untrusted comment: minisign public key: TEST\n{}\n", STANDARD.encode(raw)))
    }
    fn sign(&self, data: &[u8]) -> String {
        let sig = self.key.sign(&Blake2b512::digest(data)).to_bytes();
        let comment = "timestamp:1\tfile:test.tar.gz";
        let mut msg = sig.to_vec();
        msg.extend_from_slice(comment.as_bytes());
        let global = self.key.sign(&msg).to_bytes();
        let mut raw = vec![0x45, 0x44];
        raw.extend_from_slice(&self.key_id);
        raw.extend_from_slice(&sig);
        STANDARD.encode(format!(
            "untrusted comment: signature from test key\n{}\ntrusted comment: {}\n{}\n",
            STANDARD.encode(raw),
            comment,
            STANDARD.encode(global)
        ))
    }
}

#[derive(Default, Clone)]
struct Pack {
    version: String,
    no_sidecar: bool,
    no_exe: bool,
    evil_path: bool,
    symlink: bool,
    nested: bool,
}

fn make_targz(p: &Pack) -> Vec<u8> {
    let mut b = tar::Builder::new(flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast()));
    let pre = if p.nested { "Jejak/" } else { "" };
    let mut add = |name: &str, data: &[u8]| {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        b.append_data(&mut h, name, data).unwrap();
    };
    if !p.no_exe {
        add(&format!("{pre}Jejak"), b"#!/bin/sh\necho baru\n");
    } else {
        add(&format!("{pre}Lain"), b"x");
    }
    if !p.no_sidecar {
        add(&format!("{pre}jejak-server"), b"sidecar-baru");
    }
    add(&format!("{pre}VERSION"), format!("{}\n", p.version).as_bytes());
    add(&format!("{pre}lib/data.txt"), b"x");
    if p.evil_path {
        let mut h = tar::Header::new_gnu();
        let name = b"../evil.txt";
        h.as_old_mut().name[..name.len()].copy_from_slice(name);
        h.set_size(5);
        h.set_mode(0o644);
        h.set_cksum();
        b.append(&h, &b"jahat"[..]).unwrap();
    }
    if p.symlink {
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_cksum();
        b.append_link(&mut h, format!("{pre}link"), "/etc/passwd").unwrap();
    }
    b.into_inner().unwrap().finish().unwrap()
}

type Routes = Arc<Mutex<HashMap<String, (u16, Vec<u8>)>>>;

/// Server HTTP minimal di 127.0.0.1; rute `/jalur` → (status, badan).
fn serve() -> (String, Routes) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes: Routes = Arc::default();
    let r = routes.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let mut buf = [0u8; 4096];
            let n = s.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let (status, body) = r.lock().unwrap().get(&path).cloned().unwrap_or((404, Vec::new()));
            let head = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        }
    });
    (base, routes)
}

fn manifest_json(version: &str, url: &str, sig: &str) -> String {
    format!(r#"{{"version":"{version}","notes":"catatan","pub_date":"2026-01-01T00:00:00Z","platforms":{{"linux-x86_64-native":{{"url":"{url}","signature":"{sig}"}}}}}}"#)
}

struct Rig {
    updater: Updater,
    root: PathBuf,
    install: PathBuf,
    work: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn rig(current: &str, pubkey: &str, base: &str, allow_insecure: bool) -> Rig {
    let root = std::env::temp_dir().join(format!("jejak-up-{}-{}", std::process::id(), jejak_desktop::token::generate().unwrap()));
    let install = root.join("app");
    let work = root.join("work");
    std::fs::create_dir_all(&install).unwrap();
    let base = base.to_string();
    let updater = Updater::new(Config {
        current: Semver::parse(current).unwrap(),
        install_dir: install.clone(),
        work_dir: work.clone(),
        pubkey: pubkey.to_string(),
        platform_key: "linux-x86_64-native".into(),
        endpoint: Box::new(move |ch| matches!(ch, "stable" | "beta").then(|| format!("{base}/{ch}/latest.json"))),
        allow_insecure,
    });
    Rig { updater, root, install, work }
}

fn wait_for(u: &Updater, phases: &[Phase]) -> Status {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let s = u.status();
        if phases.contains(&s.state) {
            return s;
        }
        assert!(Instant::now() < end, "menunggu status habis waktu: {:?}", s.state);
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Publikasikan arsip + manifest untuk satu kanal lalu kembalikan rig.
fn scenario(current: &str, manifest_version: &str, pack: &Pack, sign_other: bool) -> (Rig, Routes) {
    let signer = TestSigner::new(3);
    let tgz = make_targz(pack);
    let sig = if sign_other { signer.sign(b"lain") } else { signer.sign(&tgz) };
    let (base, routes) = serve();
    {
        let mut r = routes.lock().unwrap();
        r.insert("/beta/latest.json".into(), (200, manifest_json(manifest_version, &format!("{base}/a.tar.gz"), &sig).into_bytes()));
        r.insert("/a.tar.gz".into(), (200, tgz));
    }
    (rig(current, &signer.pubkey(), &base, true), routes)
}

fn pack(version: &str) -> Pack {
    Pack { version: version.into(), nested: true, ..Default::default() }
}

#[test]
fn semver_order_and_invalid() {
    let v = |s: &str| Semver::parse(s).unwrap_or_else(|| panic!("{s}"));
    assert!(v("0.1.0-beta.20") > v("0.1.0-beta.19"));
    assert!(v("0.1.0-beta.9") < v("0.1.0-beta.10"));
    assert!(v("0.1.0") > v("0.1.0-beta.99"));
    assert!(v("0.2.0-beta.1") > v("0.1.9"));
    assert_eq!(v("v1.2.3+abc"), v("1.2.3"));
    assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
    assert!(v("1.0.0-1") < v("1.0.0-alpha"));
    assert_eq!(v("0.1.0-beta.19").to_string(), "0.1.0-beta.19");
    for bad in ["", "1.2", "1.2.x", "1.2.3-", "1.2.3-a..b", "-1.2.3", "1.2.3.4", "1.-2.3"] {
        assert!(Semver::parse(bad).is_none(), "{bad}");
    }
}

#[test]
fn minisign_real_fixture_and_rejections() {
    let k = PublicKey::from_base64(KUNCI_UJI).unwrap();
    k.verify_data(HELLO, SIG_UJI).unwrap();
    let f = std::env::temp_dir().join(format!("jejak-sig-{}", std::process::id()));
    std::fs::write(&f, HELLO).unwrap();
    k.verify_file(&f, SIG_UJI).unwrap();
    let _ = std::fs::remove_file(&f);
    assert!(k.verify_data(b"hello-update!\n", SIG_UJI).is_err());
    assert!(PublicKey::from_base64(&TestSigner::new(9).pubkey()).unwrap().verify_data(HELLO, SIG_UJI).is_err());
    let text = String::from_utf8(STANDARD.decode(SIG_UJI).unwrap()).unwrap().replace("file:a.bin", "file:b.bin");
    assert!(k.verify_data(HELLO, &STANDARD.encode(text)).is_err());
    assert!(PublicKey::from_base64("bukan-base64!").is_err());
    assert!(PublicKey::from_base64(&STANDARD.encode("a\nb")).is_err());
    assert!(k.verify_data(HELLO, "").is_err());
    assert!(k.verify_data(HELLO, &STANDARD.encode("a\nb\nc\nd")).is_err());
    let t = TestSigner::new(5);
    PublicKey::from_base64(&t.pubkey()).unwrap().verify_data(HELLO, &t.sign(HELLO)).unwrap();
}

#[test]
fn manifest_and_settings() {
    let json = r#"{"version":"0.1.0-beta.20","notes":"n","pub_date":"d","platforms":{
        "linux-x86_64-native":{"url":"https://x/y.tar.gz","signature":"abc"},
        "linux-aarch64-native":{"url":"https://x/z","signature":""},
        "windows":{"url":"bukan url","signature":"s"},
        "darwin":"rusak"}}"#;
    let m = Manifest::parse(json.as_bytes()).unwrap();
    assert_eq!(m.version.to_string(), "0.1.0-beta.20");
    assert_eq!(m.platforms.len(), 1);
    assert!(Manifest::parse(b"{}").is_err() && Manifest::parse(b"rusak").is_err());
    assert!(manifest::native_platform_key().starts_with("linux-") && manifest::native_platform_key().ends_with("-native"));

    assert_eq!(manifest::default_channel("0.1.0-beta.1"), "beta");
    assert_eq!(manifest::default_channel("1.0.0"), "stable");
    assert!(manifest::endpoint("x").is_none() && manifest::endpoint("beta").unwrap().contains("/beta/"));
    let dir = std::env::temp_dir().join(format!("jejak-set-{}", std::process::id()));
    let store = SettingsStore::new(dir.join("u.json"), "0.1.0-beta.1");
    assert_eq!(store.load(), Settings { auto_check: true, channel: "beta".into() });
    store.save(&Settings { auto_check: false, channel: "stable".into() }).unwrap();
    assert_eq!(store.load(), Settings { auto_check: false, channel: "stable".into() });
    std::fs::write(dir.join("u.json"), "{rusak").unwrap();
    assert_eq!(store.load().channel, "beta");
    std::fs::write(dir.join("u.json"), r#"{"channel":"aneh"}"#).unwrap();
    assert_eq!(store.load().channel, "beta");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn status_transitions() {
    let mut s = Status::default();
    assert!(!s.start_download() && !s.finish_install());
    assert!(s.start_check(1) && !s.start_check(2));
    assert!(s.finish_check(3, Some("1.0.0".into()), Some("n".into()), None) && s.state == Phase::Available);
    assert!(s.start_download() && s.progress(5, Some(10)) && s.downloaded == 5);
    assert!(s.finish_download() && s.finish_install() && s.state == Phase::Ready);
    let j = s.to_json();
    assert_eq!((j["state"].as_str(), j["version"].as_str()), (Some("ready"), Some("1.0.0")));
    s.fail(9, "x".into());
    assert!(s.state == Phase::Error && s.start_check(10));
}

#[test]
fn full_flow_check_install_ready_apply() {
    let (rig, _r) = scenario("0.1.0-beta.19", "0.1.0-beta.20", &pack("0.1.0-beta.20"), false);
    let s = rig.updater.check("beta");
    assert_eq!((s.state, s.version.as_deref(), s.notes.as_deref()), (Phase::Available, Some("0.1.0-beta.20"), Some("catatan")), "{:?}", s.error);
    rig.updater.install().unwrap();
    let s = wait_for(&rig.updater, &[Phase::Ready, Phase::Error]);
    assert_eq!(s.state, Phase::Ready, "{:?}", s.error);
    let staged = rig.updater.staged_dir().unwrap();
    assert!(staged.join("Jejak").is_file() && staged.join("lib/data.txt").is_file());
    assert!(std::fs::read_dir(&rig.install).unwrap().next().is_none(), "folder aplikasi tak boleh disentuh sebelum mulai ulang");

    // Penyalinan: berkas lama ditimpa atomik, mode eksekusi terjaga, tanpa sisa sementara.
    std::fs::write(rig.install.join("Jejak"), "lama").unwrap();
    updater::apply(&staged, &rig.install).unwrap();
    assert_eq!(std::fs::read_to_string(rig.install.join("Jejak")).unwrap(), "#!/bin/sh\necho baru\n");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(rig.install.join("Jejak")).unwrap().permissions().mode() & 0o111, 0o111);
    assert_eq!(std::fs::metadata(rig.install.join("jejak-server")).unwrap().permissions().mode() & 0o111, 0o111);
    assert!(rig.install.join("lib/data.txt").is_file());
    assert!(std::fs::read_dir(&rig.install).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("jejak-new")));
}

#[test]
fn archive_without_wrapper_folder_accepted() {
    let (rig, _r) = scenario("0.1.0", "0.2.0", &Pack { version: "0.2.0".into(), nested: false, ..Default::default() }, false);
    assert_eq!(rig.updater.check("beta").state, Phase::Available);
    rig.updater.install().unwrap();
    assert_eq!(wait_for(&rig.updater, &[Phase::Ready, Phase::Error]).state, Phase::Ready);
}

#[test]
fn up_to_date_or_no_platform_is_idle() {
    let (rig, routes) = scenario("0.1.0", "0.1.0", &pack("0.1.0"), false);
    assert_eq!(rig.updater.check("beta").state, Phase::Idle);
    assert!(rig.updater.install().is_err());
    routes.lock().unwrap().insert(
        "/beta/latest.json".into(),
        (200, br#"{"version":"9.0.0","platforms":{"darwin-aarch64-native":{"url":"https://x/a","signature":"s"}}}"#.to_vec()),
    );
    assert_eq!(rig.updater.check("beta").state, Phase::Idle);
}

fn assert_install_fails(pk: &Pack, manifest_version: &str, sign_other: bool, label: &str) {
    let (rig, _r) = scenario("0.1.0", manifest_version, pk, sign_other);
    assert_eq!(rig.updater.check("beta").state, Phase::Available, "{label}");
    rig.updater.install().unwrap();
    let s = wait_for(&rig.updater, &[Phase::Ready, Phase::Error]);
    assert_eq!(s.state, Phase::Error, "{label}");
    assert!(rig.updater.staged_dir().is_none(), "{label}");
    let left = std::fs::read_dir(&rig.work).map(|d| d.count()).unwrap_or(0);
    assert_eq!(left, 0, "{label}: sisa di folder kerja");
    assert!(!rig.root.join("evil.txt").exists() && !rig.work.join("evil.txt").exists(), "{label}");
}

#[test]
fn rejects_bad_signature_version_and_malformed_archives() {
    assert_install_fails(&pack("0.2.0"), "0.2.0", true, "tanda tangan salah");
    assert_install_fails(&pack("0.9.9"), "0.2.0", false, "versi tak cocok");
    assert_install_fails(&Pack { no_sidecar: true, ..pack("0.2.0") }, "0.2.0", false, "tanpa sidecar");
    assert_install_fails(&Pack { no_exe: true, ..pack("0.2.0") }, "0.2.0", false, "tanpa exe");
    assert_install_fails(&Pack { evil_path: true, ..pack("0.2.0") }, "0.2.0", false, "path traversal");
    assert_install_fails(&Pack { symlink: true, ..pack("0.2.0") }, "0.2.0", false, "symlink");
}

#[test]
fn http_refused_unknown_channel_and_stable_404() {
    let signer = TestSigner::new(3);
    let (base, routes) = serve();
    routes.lock().unwrap().insert("/beta/latest.json".into(), (200, manifest_json("0.2.0", &format!("{base}/a"), &signer.sign(b"x")).into_bytes()));
    let rig = rig("0.1.0", &signer.pubkey(), &base, false); // tanpa override: http ditolak
    let s = rig.updater.check("beta");
    assert_eq!(s.state, Phase::Error);
    assert!(s.error.unwrap().contains("https"));
    assert_eq!(rig.updater.check("aneh").state, Phase::Error);
    let rig2 = self::rig("0.1.0", &signer.pubkey(), &base, true);
    let s = rig2.updater.check("stable"); // rute /stable/latest.json tak ada → 404
    assert_eq!(s.state, Phase::Error);
    let e = s.error.unwrap().to_lowercase();
    assert!(e.contains("stabil") || e.contains("stable"), "{e}");
}

#[test]
fn unwritable_install_dir_and_relaunch_args() {
    assert!(updater::ensure_writable(Path::new("/tidak/ada/jejak")).is_err());
    let dir = std::env::temp_dir();
    updater::ensure_writable(&dir).unwrap();
    let a = updater::relaunch_args(42, Path::new("/opt/Jejak app/Jejak"));
    assert_eq!(a[3], "42");
    assert_eq!(a[4], "/opt/Jejak app/Jejak"); // jalur utuh sebagai argumen, bukan di teks skrip
    assert!(a[1].contains("kill -0") && a[1].contains("exec"));
}

#[test]
fn service_restart_requires_ready_update() {
    let dir = std::env::temp_dir().join(format!("jejak-svc-{}", std::process::id()));
    let svc = updater::UpdateService::new(None, SettingsStore::new(dir.join("u.json"), "0.1.0"), dir.clone());
    assert!(svc.prepare_restart().is_err() && svc.install().is_err());
    assert_eq!(svc.status_json()["state"], "idle");
    assert!(svc.apply_settings(Settings { auto_check: true, channel: "nightly".into() }).is_err());
    svc.apply_settings(Settings { auto_check: false, channel: "beta".into() }).unwrap();
    assert_eq!(svc.settings(), Settings { auto_check: false, channel: "beta".into() });
    let _ = std::fs::remove_dir_all(&dir);
}
