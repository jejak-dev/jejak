use jejak_desktop::{l10n, locator, navigation as nav, ready_line, ring::LineRing, sidecar::Sidecar, token};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn fake(body: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("jejak-test-{}-{}", std::process::id(), token::generate().unwrap()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("jejak");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn ready_line_valid_and_ignored() {
    let i = ready_line::parse(r#"JEJAK_READY {"port":51234,"host":"127.0.0.1","version":"0.0.1"}"#).unwrap().unwrap();
    assert_eq!((i.port, i.host.as_str(), i.version.as_str()), (51234, "127.0.0.1", "0.0.1"));
    assert!(ready_line::parse("server mendengarkan").unwrap().is_none());
    assert!(ready_line::parse(r#"JEJAK_READYX {"port":1}"#).unwrap().is_none());
    let d = ready_line::parse(r#"JEJAK_READY {"port":8}"#).unwrap().unwrap();
    assert_eq!((d.host.as_str(), d.version.as_str()), ("127.0.0.1", ""));
}

#[test]
fn ready_line_errors() {
    for bad in [
        "JEJAK_READY", "JEJAK_READY   ", "JEJAK_READY {rusak", r#"JEJAK_READY {"host":"x"}"#,
        r#"JEJAK_READY {"port":0}"#, r#"JEJAK_READY {"port":70000}"#, r#"JEJAK_READY {"port":true}"#,
    ] {
        assert!(ready_line::parse(bad).is_err(), "{bad}");
    }
}

#[test]
fn token_generation_and_validity() {
    let t = token::generate().unwrap();
    assert!(token::is_valid(&t) && t.len() == 43);
    assert_ne!(t, token::generate().unwrap());
    assert!(!token::is_valid("pendek"));
    assert!(!token::is_valid(&"a".repeat(31)));
    assert!(!token::is_valid(&format!("{}+", "a".repeat(31))));
    assert!(token::is_valid(&"a".repeat(32)));
    assert_eq!(token::base64url(b"\xfb\xff"), "-_8");
    assert_eq!(token::base64url(b"foobar"), "Zm9vYmFy");
}

#[test]
fn navigation_allowlist() {
    assert_eq!(nav::enter_url(5, "abc"), "http://127.0.0.1:5/__desktop/enter?t=abc");
    assert!(nav::is_allowed_navigation("http://127.0.0.1:5000/x?y=1", 5000));
    assert!(nav::is_allowed_navigation("about:blank", 5000));
    for no in [
        "http://127.0.0.1:5001/", "http://localhost:5000/", "https://127.0.0.1:5000/", "https://example.com",
        "file:///etc/passwd", "http://127.0.0.1:5000@evil.com/", "http://evil.com@127.0.0.1:5000/", "http://127.0.0.1/",
    ] {
        assert!(!nav::is_allowed_navigation(no, 5000), "{no}");
    }
    assert!(!nav::is_allowed_navigation("http://127.0.0.1:5000/", 0));
}

#[test]
fn navigation_external_targets() {
    assert_eq!(nav::external_open_target("https://example.com/a", 5000).as_deref(), Some("https://example.com/a"));
    assert!(nav::external_open_target("http://127.0.0.1:5000/a", 5000).is_none());
    for no in ["javascript:alert(1)", "file:///x", "data:text/html,x", "ftp://x/y"] {
        assert!(nav::external_open_target(no, 5000).is_none(), "{no}");
    }
}

#[test]
fn ring_keeps_last_lines() {
    let r = LineRing::new(3);
    for i in 1..=5 {
        r.append(format!("b{i}"));
    }
    assert_eq!(r.snapshot(), ["b3", "b4", "b5"]);
    assert_eq!(r.summary(2), "b4\nb5");
}

#[test]
fn l10n_languages_and_args() {
    l10n::set_language(Some("id"));
    assert_eq!(l10n::l("button.retry", "Coba lagi", &[]), "Coba lagi");
    l10n::set_language(Some("en"));
    assert_eq!(l10n::l("button.retry", "Coba lagi", &[]), "Try again");
    assert_eq!(l10n::l("ready.port_range", "x %@", &["7"]), "JEJAK_READY port out of range: 7");
    assert_eq!(l10n::l("kunci.tak.ada", "teks %@ dan %@", &["a", "b"]), "teks a dan b");
    l10n::set_language(None);
}

#[test]
fn locator_env_and_candidates() {
    let bin = fake("exit 0");
    let dir = bin.parent().unwrap().to_path_buf();
    let b = bin.display().to_string();
    let env_ok = move |k: &str| (k == "JEJAK_SIDECAR").then(|| b.clone());
    assert_eq!(locator::locate(&dir, &env_ok).unwrap(), bin);
    let env_bad = |k: &str| (k == "JEJAK_SIDECAR").then(|| "/tidak/ada".to_string());
    assert!(locator::locate(&dir, &env_bad).is_err());
    assert_eq!(locator::locate(&dir, &|_| None).unwrap(), bin);
    assert!(locator::locate(&dir.join("kosong"), &|_| None).is_err());
}

#[test]
fn sidecar_ready_then_stop_on_stdin_close() {
    let bin = fake(r#"echo "JEJAK_READY {\"port\":4321,\"version\":\"9\"}"
[ -n "$JEJAK_DESKTOP_TOKEN" ] || exit 7
[ "$PORT" = "0" ] || exit 8
cat > /dev/null"#);
    let s = Sidecar::start(&bin, &token::generate().unwrap(), &[], None).unwrap();
    let info = s.wait_ready(Duration::from_secs(10)).unwrap();
    assert_eq!((info.port, info.version.as_str()), (4321, "9"));
    let t = Instant::now();
    s.stop();
    assert!(t.elapsed() < Duration::from_millis(2500), "{:?}", t.elapsed());
    assert!(!s.is_running());
    s.stop();
}

#[test]
fn sidecar_exit_before_ready_reports_stderr() {
    let bin = fake("echo kaboom >&2\nexit 3");
    let s = Sidecar::start(&bin, &token::generate().unwrap(), &[], None).unwrap();
    let e = s.wait_ready(Duration::from_secs(10)).unwrap_err();
    assert!(e.contains("kaboom"), "{e}");
}

#[test]
fn sidecar_timeout() {
    let bin = fake("cat > /dev/null");
    let s = Sidecar::start(&bin, &token::generate().unwrap(), &[], None).unwrap();
    assert!(s.wait_ready(Duration::from_millis(300)).is_err());
}

#[test]
fn sidecar_unexpected_exit_calls_handler() {
    let bin = fake("echo 'JEJAK_READY {\"port\":9}'\nsleep 0.3\nexit 5");
    let (tx, rx) = mpsc::channel();
    let s = Sidecar::start(&bin, &token::generate().unwrap(), &[], Some(Box::new(move |c| { let _ = tx.send(c); }))).unwrap();
    s.wait_ready(Duration::from_secs(10)).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 5);
}

#[test]
fn sidecar_stop_kills_grandchildren_without_handler() {
    let marker = std::env::temp_dir().join(format!("jejak-gc-{}", token::generate().unwrap()));
    let bin = fake(&format!("echo 'JEJAK_READY {{\"port\":9}}'\n(sleep 60; : > {}) &\nwait", marker.display()));
    let (tx, rx) = mpsc::channel();
    let s = Sidecar::start(&bin, &token::generate().unwrap(), &[], Some(Box::new(move |c| { let _ = tx.send(c); }))).unwrap();
    s.wait_ready(Duration::from_secs(10)).unwrap();
    s.stop();
    std::thread::sleep(Duration::from_millis(300));
    assert!(rx.try_recv().is_err(), "handler terpanggil");
    assert!(!marker.exists());
}

#[test]
fn sidecar_real_binary_if_provided() {
    let Ok(real) = std::env::var("JEJAK_REAL_SIDECAR") else { return };
    let s = Sidecar::start(&PathBuf::from(real), &token::generate().unwrap(), &[], None).unwrap();
    let info = s.wait_ready(Duration::from_secs(30)).unwrap();
    assert!(info.port > 0);
    s.stop();
    assert!(!s.is_running());
}

#[test]
fn bridge_commands() {
    use jejak_desktop::bridge::Bridge;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let s2 = seen.clone();
    let b = Bridge::new(Box::new(move |t, body| s2.lock().unwrap().push((t.to_string(), body.to_string()))));
    let info = b.handle("desktop_info", &json!(null)).unwrap();
    assert_eq!(info["platform"], "linux");
    assert!(info["version"].as_str().unwrap().len() > 0);
    // pengaturan: bentuk bersarang dan datar, nilai buruk ditolak
    assert_eq!(b.handle("updater_set_settings", &json!({"settings": {"autoCheck": false, "channel": "beta"}})).unwrap(), json!({"autoCheck": false, "channel": "beta"}));
    assert_eq!(b.handle("updater_get_settings", &json!(null)).unwrap(), json!({"autoCheck": false, "channel": "beta"}));
    assert!(b.handle("updater_set_settings", &json!({"autoCheck": true, "channel": "nightly"})).is_err());
    assert!(b.handle("updater_set_settings", &json!(null)).is_err());
    // pembaru belum tersedia
    assert_eq!(b.handle("updater_status", &json!(null)).unwrap()["state"], "idle");
    assert_eq!(b.handle("updater_check", &json!(null)).unwrap()["state"], "error");
    assert!(b.handle("updater_install", &json!(null)).is_err());
    // notifikasi
    assert_eq!(b.handle("plugin:notification|is_permission_granted", &json!(null)).unwrap(), json!(true));
    b.handle("plugin:notification|notify", &json!({"options": {"title": "T", "body": "B"}})).unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), [("T".to_string(), "B".to_string())]);
    assert!(b.handle("nope", &json!(null)).is_err());
}

#[test]
fn bridge_reply_script_escapes_payload() {
    use jejak_desktop::bridge::Bridge;
    let s = Bridge::reply_script(3, &Err("a\"b</script>".to_string()));
    assert_eq!(s, "window.__jejakReply(3, false, \"a\\\"b</script>\");");
    let ok = Bridge::reply_script(4, &Ok(serde_json::json!({"x": 1})));
    assert_eq!(ok, "window.__jejakReply(4, true, {\"x\":1});");
}
