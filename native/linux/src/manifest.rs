//! Manifest pembaruan (`latest.json`, format statis Tauri v2) dan pengaturan pembaruan.

use crate::l10n::l;
use crate::semver::Semver;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq)]
pub struct Platform {
    pub url: String,
    pub signature: String,
}

#[derive(Debug, Clone)]
pub struct Manifest {
    pub version: Semver,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub platforms: HashMap<String, Platform>,
}

/// Kunci platform cangkang native Linux. Sengaja berbeda dari kunci Tauri
/// (`linux-x86_64`) supaya cangkang native tak memasang artefak Tauri dan sebaliknya.
pub fn native_platform_key() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "linux-aarch64-native"
    } else {
        "linux-x86_64-native"
    }
}

impl Manifest {
    pub fn parse(data: &[u8]) -> Result<Manifest, String> {
        let bad = || l("manifest.bad", "manifest pembaruan rusak", &[]);
        let v: Value = serde_json::from_slice(data).map_err(|_| bad())?;
        let version = v.get("version").and_then(Value::as_str).and_then(Semver::parse).ok_or_else(bad)?;
        let mut platforms = HashMap::new();
        if let Some(map) = v.get("platforms").and_then(Value::as_object) {
            for (k, p) in map {
                let (Some(url), Some(sig)) = (p.get("url").and_then(Value::as_str), p.get("signature").and_then(Value::as_str)) else {
                    continue;
                };
                if sig.is_empty() || !(url.starts_with("https://") || url.starts_with("http://")) {
                    continue;
                }
                platforms.insert(k.clone(), Platform { url: url.to_string(), signature: sig.to_string() });
            }
        }
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Ok(Manifest { version, notes: text("notes"), date: text("pub_date"), platforms })
    }
}

pub const STABLE: &str = "stable";
pub const BETA: &str = "beta";
pub const ENDPOINT_STABLE: &str = "https://github.com/jejak-dev/jejak/releases/latest/download/latest.json";
pub const ENDPOINT_BETA: &str = "https://github.com/jejak-dev/jejak/releases/download/beta/latest.json";

#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub auto_check: bool,
    pub channel: String,
}

/// Versi pra-rilis memakai kanal beta, rilis penuh kanal stabil.
pub fn default_channel(version: &str) -> &'static str {
    if version.contains('-') {
        BETA
    } else {
        STABLE
    }
}

pub fn is_valid_channel(c: &str) -> bool {
    c == STABLE || c == BETA
}

pub fn endpoint(channel: &str) -> Option<&'static str> {
    match channel {
        STABLE => Some(ENDPOINT_STABLE),
        BETA => Some(ENDPOINT_BETA),
        _ => None,
    }
}

/// Penyimpanan pengaturan sebagai JSON kecil (tahan berkas rusak).
pub struct SettingsStore {
    path: PathBuf,
    version: String,
}

impl SettingsStore {
    pub fn new(path: PathBuf, version: &str) -> Self {
        Self { path, version: version.to_string() }
    }

    pub fn load(&self) -> Settings {
        let fallback = Settings { auto_check: true, channel: default_channel(&self.version).to_string() };
        let Ok(text) = std::fs::read_to_string(&self.path) else { return fallback };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { return fallback };
        Settings {
            auto_check: v.get("autoCheck").and_then(Value::as_bool).unwrap_or(true),
            channel: v
                .get("channel")
                .and_then(Value::as_str)
                .filter(|c| is_valid_channel(c))
                .map(str::to_string)
                .unwrap_or(fallback.channel),
        }
    }

    pub fn save(&self, s: &Settings) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json!({"autoCheck": s.auto_check, "channel": s.channel}).to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}
