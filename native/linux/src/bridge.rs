//! Jembatan halaman → cangkang. Halaman memanggil
//! `window.__TAURI_INTERNALS__.invoke(cmd, args)` (kontrak lama Tauri); di sini
//! diterjemahkan ke perintah native tanpa mengubah klien web. Murni logika (tanpa GTK).

use crate::l10n::l;
use crate::manifest::{default_channel, is_valid_channel, Settings};
use crate::updater::UpdateService;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

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
    /// Dipakai bila tak ada layanan pembaruan (mis. uji): pengaturan hanya di memori.
    settings: Mutex<(bool, String)>,
    notify: Box<dyn Fn(&str, &str) + Send + Sync>,
    updates: Option<Arc<UpdateService>>,
    /// Dipanggil setelah berkas pembaruan disalin; menutup aplikasi (di thread UI).
    restart: Box<dyn Fn() + Send + Sync>,
}

impl Bridge {
    pub fn new(notify: Box<dyn Fn(&str, &str) + Send + Sync>) -> Self {
        let channel = default_channel(VERSION);
        Self { settings: Mutex::new((true, channel.to_string())), notify, updates: None, restart: Box::new(|| {}) }
    }

    pub fn with_updates(
        notify: Box<dyn Fn(&str, &str) + Send + Sync>,
        updates: Arc<UpdateService>,
        restart: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        let mut b = Self::new(notify);
        b.updates = Some(updates);
        b.restart = restart;
        b
    }

    fn unavailable() -> String {
        l("update.unavailable", "pembaruan otomatis tak tersedia pada build ini", &[])
    }

    fn settings_json(&self) -> Value {
        match &self.updates {
            Some(u) => {
                let s = u.settings();
                json!({"autoCheck": s.auto_check, "channel": s.channel})
            }
            None => {
                let s = self.settings.lock().unwrap();
                json!({"autoCheck": s.0, "channel": s.1})
            }
        }
    }

    /// Menjalankan satu perintah dan membalas lewat `reply` (bisa dari thread lain).
    /// Perintah lambat (periksa pembaruan memakai jaringan) berjalan di thread sendiri
    /// supaya thread UI tak macet.
    pub fn dispatch(self: &Arc<Self>, cmd: &str, args: &Value, reply: Box<dyn FnOnce(Result<Value, String>) + Send>) {
        if cmd == "updater_check" {
            if let Some(u) = self.updates.clone() {
                std::thread::spawn(move || reply(Ok(u.check())));
                return;
            }
        }
        reply(self.handle(cmd, args));
    }

    /// Menjalankan satu perintah; `Err` menjadi penolakan di sisi halaman.
    pub fn handle(&self, cmd: &str, args: &Value) -> Result<Value, String> {
        match cmd {
            "desktop_info" => Ok(json!({"version": VERSION, "platform": "linux"})),
            "updater_get_settings" => Ok(self.settings_json()),
            "updater_set_settings" => {
                // Bentuk bersarang ({settings:{..}}) atau datar ({autoCheck, channel}).
                let body = args.get("settings").unwrap_or(args);
                let auto = body.get("autoCheck").and_then(Value::as_bool);
                let channel = body.get("channel").and_then(Value::as_str).filter(|c| is_valid_channel(c));
                let (Some(auto), Some(channel)) = (auto, channel) else {
                    return Err(l("update.incomplete", "pengaturan pembaruan tak lengkap", &[]));
                };
                match &self.updates {
                    Some(u) => u.apply_settings(Settings { auto_check: auto, channel: channel.to_string() })?,
                    None => *self.settings.lock().unwrap() = (auto, channel.to_string()),
                }
                Ok(self.settings_json())
            }
            "updater_status" => Ok(match &self.updates {
                Some(u) => u.status_json(),
                None => json!({"state": "idle", "downloaded": 0}),
            }),
            "updater_check" => Ok(match &self.updates {
                Some(u) => u.check(),
                None => json!({"state": "idle", "downloaded": 0}),
            }),
            "updater_install" => self.updates.as_ref().ok_or_else(Self::unavailable)?.install(),
            "updater_restart" => {
                self.updates.as_ref().ok_or_else(Self::unavailable)?.prepare_restart()?;
                (self.restart)();
                Ok(Value::Null)
            }
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
