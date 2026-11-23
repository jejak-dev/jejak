//! Jembatan halaman → cangkang. Halaman memanggil
//! `window.__TAURI_INTERNALS__.invoke(cmd, args)` (kontrak lama Tauri); di sini
//! diterjemahkan ke perintah native tanpa mengubah klien web. Murni logika (tanpa GTK).

use crate::l10n::l;
use serde_json::{json, Value};
use std::sync::Mutex;

pub const VERSION: &str = env!("JEJAK_VERSION");

/// Shim notifikasi lama (Notification API di atas jembatan ini); satu salinan di src-tauri/shim.
pub const NOTIFICATION_SHIM: &str = include_str!("../../../src-tauri/shim/notification.js");

/// Dipasang di awal dokumen. Pesan: `{id, cmd, args}`; balasan lewat `window.__jejakReply`.
pub const SHIM: &str = r#"
(function () {
  if (window.__TAURI_INTERNALS__) return;
  var pending = new Map();
  var next = 1;
  window.__jejakReply = function (id, ok, payload) {
    var e = pending.get(id);
    if (!e) return;
    pending.delete(id);
    if (ok) e.resolve(payload); else e.reject(typeof payload === 'string' ? payload : 'error');
  };
  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd, args) {
      return new Promise(function (resolve, reject) {
        var id = next++;
        pending.set(id, { resolve: resolve, reject: reject });
        window.webkit.messageHandlers.jejak.postMessage({ id: id, cmd: cmd, args: args === undefined ? null : args });
      });
    }
  };
})();
"#;

pub struct Bridge {
    settings: Mutex<(bool, String)>,
    notify: Box<dyn Fn(&str, &str) + Send + Sync>,
}

impl Bridge {
    pub fn new(notify: Box<dyn Fn(&str, &str) + Send + Sync>) -> Self {
        let channel = if VERSION.contains('-') { "beta" } else { "stable" };
        Self { settings: Mutex::new((true, channel.to_string())), notify }
    }

    fn status(error: Option<String>) -> Value {
        match error {
            None => json!({"state": "idle", "downloaded": 0}),
            Some(e) => json!({"state": "error", "downloaded": 0, "error": e}),
        }
    }

    fn unavailable() -> String {
        l("bridge.updater_unavailable", "pembaruan otomatis belum tersedia di cangkang Linux", &[])
    }

    /// Menjalankan satu perintah; `Err` menjadi penolakan di sisi halaman.
    pub fn handle(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        match cmd {
            "desktop_info" => Ok(json!({"version": VERSION, "platform": "linux"})),
            "updater_get_settings" => {
                let s = self.settings.lock().unwrap();
                Ok(json!({"autoCheck": s.0, "channel": s.1}))
            }
            "updater_set_settings" => {
                // Bentuk bersarang ({settings:{..}}) atau datar ({autoCheck, channel}).
                let body = args.get("settings").unwrap_or(args);
                let auto = body.get("autoCheck").and_then(Value::as_bool);
                let channel = body.get("channel").and_then(Value::as_str).filter(|c| *c == "stable" || *c == "beta");
                let (Some(auto), Some(channel)) = (auto, channel) else {
                    return Err(l("update.incomplete", "pengaturan pembaruan tak lengkap", &[]));
                };
                *self.settings.lock().unwrap() = (auto, channel.to_string());
                Ok(json!({"autoCheck": auto, "channel": channel}))
            }
            "updater_status" => Ok(Self::status(None)),
            "updater_check" => Ok(Self::status(Some(Self::unavailable()))),
            "updater_install" | "updater_restart" => Err(Self::unavailable()),
            "plugin:notification|is_permission_granted" => Ok(json!(true)),
            "plugin:notification|request_permission" => Ok(json!("granted")),
            "plugin:notification|notify" => {
                let opts = args.get("options");
                let title = opts.and_then(|o| o.get("title")).and_then(Value::as_str).unwrap_or("Jejak");
                let body = opts.and_then(|o| o.get("body")).and_then(Value::as_str).unwrap_or("");
                (self.notify)(title, body);
                Ok(Value::Null)
            }
            other => Err(l("bridge.unknown_command", "perintah tak dikenal: %@", &[other])),
        }
    }

    /// Satu pintu untuk sukses dan gagal; payload diserialisasi SEKALI (bukan digabung string).
    pub fn reply_script(id: i64, result: &Result<Value, String>) -> String {
        let (ok, payload) = match result {
            Ok(v) => ("true", v.to_string()),
            Err(e) => ("false", Value::String(e.clone()).to_string()),
        };
        format!("window.__jejakReply({id}, {ok}, {payload});")
    }
}
