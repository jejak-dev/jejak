//! Teks dua bahasa: kunci + teks bawaan Indonesia di kode, tabel Inggris di sini.
//! Bahasa dari LC_ALL / LC_MESSAGES / LANG (awalan `id` = Indonesia, lainnya = Inggris
//! bila ada terjemahan).

use std::sync::Mutex;

static OVERRIDE: Mutex<Option<String>> = Mutex::new(None);

/// Menimpa bahasa (uji); `None` = ikuti lingkungan.
pub fn set_language(lang: Option<&str>) {
    *OVERRIDE.lock().unwrap() = lang.map(|s| s.to_string());
}

fn language() -> String {
    if let Some(l) = OVERRIDE.lock().unwrap().clone() {
        return l;
    }
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() && v != "C" && v != "POSIX" {
                return v.chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>().to_lowercase();
            }
        }
    }
    "en".to_string()
}

const ENGLISH: &[(&str, &str)] = &[
    ("ready.no_payload", "JEJAK_READY line has no JSON payload"),
    ("ready.bad_json", "JEJAK_READY payload is not valid JSON"),
    ("ready.no_port", "JEJAK_READY payload has no port"),
    ("ready.port_range", "JEJAK_READY port out of range: %@"),
    ("locator.env_missing", "JEJAK_SIDECAR points to a file that does not exist: %@"),
    ("locator.not_found", "sidecar binary not found. Tried: %@"),
    ("token.random", "could not create a random token: %@"),
    ("sidecar.spawn", "failed to launch sidecar %@: %@"),
    ("sidecar.start_failed_generic", "The Jejak server could not start"),
    ("sidecar.exited_before_ready", "The Jejak server stopped before it was ready"),
    ("sidecar.timeout", "The Jejak server was not ready within %@ seconds"),
    ("splash.starting", "Starting Jejak…"),
    ("error.start_failed", "Jejak couldn't start"),
    ("error.server_exited", "The Jejak server stopped unexpectedly (code %@)"),
    ("error.no_output", "(no output from the server)"),
    ("button.retry", "Try again"),
    ("button.copy", "Copy"),
    ("sign.bad_pubkey", "invalid update public key"),
    ("sign.read", "the downloaded file could not be read"),
    ("sign.invalid", "update signature does not match"),
    ("sign.bad_format", "update signature format is corrupted"),
    ("sign.legacy", "legacy signature variant not accepted"),
    ("sign.wrong_key", "signature was made with a different key"),
    ("manifest.bad", "update manifest is corrupted"),
    ("update.bad_channel", "unknown update channel"),
    ("update.insecure", "update address must be https"),
    ("update.no_stable", "No stable release yet. Choose the Beta channel in Settings."),
    ("update.http", "update server answered %@"),
    ("update.busy", "an update is already being installed"),
    ("update.none", "there is no update to install"),
    ("update.too_large", "the update download is too large"),
    ("update.not_writable", "the application folder is not writable: %@"),
    ("update.bad_archive", "invalid update archive"),
    ("update.wrong_app", "the update archive is not the native Jejak app"),
    ("update.bad_app", "invalid update application"),
    ("update.version_mismatch", "the archive's app version does not match the manifest"),
    ("update.unavailable", "automatic updates are not available in this build"),
    ("update.not_ready", "no update is ready to run"),
    ("bridge.unknown_command", "unknown command: %@"),
    ("bridge.rejected", "bridge message rejected: unknown origin"),
    ("update.incomplete", "update settings are incomplete"),
];

/// Teks terlokalisasi; `%@` diganti argumen berurutan.
pub fn l(key: &str, fallback: &str, args: &[&str]) -> String {
    let mut text = fallback.to_string();
    if language() != "id" {
        if let Some((_, en)) = ENGLISH.iter().find(|(k, _)| *k == key) {
            text = en.to_string();
        }
    }
    if args.is_empty() {
        return text;
    }
    let mut parts = text.split("%@");
    let mut out = parts.next().unwrap_or("").to_string();
    for (i, part) in parts.enumerate() {
        out.push_str(args.get(i).copied().unwrap_or(""));
        out.push_str(part);
    }
    out
}
