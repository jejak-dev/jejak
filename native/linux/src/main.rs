//! Jejak untuk Linux: jendela GTK3 + WebKitGTK yang memuat server Jejak lokal
//! (sidecar `jejak serve --desktop`). Logika murni ada di pustaka; berkas ini hanya GTK.

use gtk::prelude::*;
use javascriptcore::ValueExt;
use jejak_desktop::bridge::{self, Bridge};
use jejak_desktop::l10n::l;
use jejak_desktop::sidecar::{Sidecar, READY_TIMEOUT};
use jejak_desktop::{locator, navigation, token};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;
use webkit2gtk::{
    CookieManagerExt, CookiePersistentStorage, LoadEvent, NavigationPolicyDecision, NavigationPolicyDecisionExt,
    PermissionRequestExt, PolicyDecisionExt, PolicyDecisionType, SettingsExt, URIRequestExt, UserContentInjectedFrames,
    UserContentManager, UserContentManagerExt, UserMediaPermissionRequest, UserScript, UserScriptInjectionTime, WebContext,
    WebView, WebViewExt, WebsiteDataManager, WebsiteDataManagerExt,
};

/// Pesan dari thread latar ke thread GTK.
enum Msg {
    Ready { port: u16, token: String },
    Failed(String),
    ServerExited(i32),
    Quit,
}

struct Ui {
    window: gtk::ApplicationWindow,
    stack: gtk::Stack,
    splash_label: gtk::Label,
    error_label: gtk::Label,
    error_text: gtk::TextView,
    web: WebView,
    port: Cell<u16>,
    sidecar: RefCell<Option<Arc<Sidecar>>>,
    closing: Cell<bool>,
}

fn open_external(url: &str, port: u16) {
    if let Some(target) = navigation::external_open_target(url, port) {
        let _ = Command::new("xdg-open").arg(target).spawn();
    }
}

fn data_dirs() -> (PathBuf, PathBuf) {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let data = std::env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(&home).join(".local/share"));
    let cache = std::env::var("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(&home).join(".cache"));
    (data.join("jejak/webkit"), cache.join("jejak/webkit"))
}

fn build_web(bridge: Arc<Bridge>, port: Rc<Cell<u16>>) -> WebView {
    let (data, cache) = data_dirs();
    let _ = std::fs::create_dir_all(&data);
    let _ = std::fs::create_dir_all(&cache);
    let manager = WebsiteDataManager::builder()
        .base_data_directory(data.to_string_lossy().as_ref())
        .base_cache_directory(cache.to_string_lossy().as_ref())
        .build();
    if let Some(cookies) = manager.cookie_manager() {
        cookies.set_persistent_storage(&data.join("cookies.sqlite").to_string_lossy(), CookiePersistentStorage::Sqlite);
    }
    let context = WebContext::with_website_data_manager(&manager);

    let content = UserContentManager::new();
    for src in [bridge::SHIM, bridge::NOTIFICATION_SHIM] {
        content.add_script(&UserScript::new(src, UserContentInjectedFrames::TopFrame, UserScriptInjectionTime::Start, &[], &[]));
    }
    content.register_script_message_handler("jejak");

    let web = WebView::builder().web_context(&context).user_content_manager(&content).build();
    if let Some(settings) = WebViewExt::settings(&web) {
        let debug = std::env::var("JEJAK_DEBUG").map(|v| v == "1").unwrap_or(false);
        settings.set_enable_developer_extras(debug);
        settings.set_enable_write_console_messages_to_stdout(debug);
        settings.set_enable_media_stream(true);
    }

    // Pesan halaman → jembatan. Hanya bila halaman teratas adalah Jejak sendiri.
    let web_for_reply = web.clone();
    let port_msg = port.clone();
    content.connect_script_message_received(Some("jejak"), move |_, value| {
        let current = web_for_reply.uri().map(|u| u.to_string()).unwrap_or_default();
        let Some(json) = value.js_value().and_then(|v| v.to_json(0)) else { return };
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(json.as_str()) else { return };
        let Some(id) = msg.get("id").and_then(|v| v.as_i64()) else { return };
        let result = if navigation::is_local_app_url(&current, port_msg.get()) {
            let cmd = msg.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
            bridge.handle(cmd, msg.get("args").unwrap_or(&serde_json::Value::Null))
        } else {
            Err(l("bridge.rejected", "pesan jembatan ditolak: asal tak dikenal", &[]))
        };
        web_for_reply.run_javascript(&Bridge::reply_script(id, &result), gtk::gio::Cancellable::NONE, |_| {});
    });

    // Daftar putih navigasi; tautan luar dibuka di browser sistem.
    let port_nav = port.clone();
    web.connect_decide_policy(move |_, decision, kind| {
        if !matches!(kind, PolicyDecisionType::NavigationAction | PolicyDecisionType::NewWindowAction) {
            return false;
        }
        let Some(nav) = decision.clone().downcast::<NavigationPolicyDecision>().ok() else { return false };
        let uri = nav.navigation_action().and_then(|a| a.request()).and_then(|r| r.uri()).map(|u| u.to_string()).unwrap_or_default();
        let allowed = kind == PolicyDecisionType::NavigationAction && navigation::is_allowed_navigation(&uri, port_nav.get());
        if allowed {
            decision.use_();
        } else {
            decision.ignore();
            open_external(&uri, port_nav.get());
        }
        true
    });

    // Mikrofon (dikte) hanya untuk halaman Jejak sendiri.
    let port_perm = port.clone();
    web.connect_permission_request(move |web, request| {
        let local = web.uri().map(|u| navigation::is_local_app_url(u.as_str(), port_perm.get())).unwrap_or(false);
        if request.is::<UserMediaPermissionRequest>() && local {
            request.allow();
        } else {
            request.deny();
        }
        true
    });

    // Proses render mati: muat ulang.
    web.connect_web_process_terminated(|web, _| web.reload());
    web
}

fn show(ui: &Ui, page: &str) {
    ui.stack.set_visible_child_name(page);
}

fn show_error(ui: &Ui, message: &str) {
    ui.error_label.set_text(&l("error.start_failed", "Jejak tidak bisa dimulai", &[]));
    let detail = if message.trim().is_empty() { l("error.no_output", "(tak ada keluaran dari server)", &[]) } else { message.to_string() };
    if let Some(buf) = ui.error_text.buffer() {
        buf.set_text(&detail);
    }
    show(ui, "error");
}

fn start(ui: &Rc<Ui>, tx: glib::Sender<Msg>) {
    ui.splash_label.set_text(&l("splash.starting", "Memulai Jejak…", &[]));
    show(ui, "splash");
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_default();
    std::thread::spawn(move || {
        let run = || -> Result<(Arc<Sidecar>, u16, String), String> {
            let binary = locator::locate(&exe_dir, &|k| std::env::var(k).ok())?;
            let tok = token::generate()?;
            let tx_exit = tx.clone();
            let sidecar = Sidecar::start(&binary, &tok, &[], Some(Box::new(move |code| {
                let _ = tx_exit.send(Msg::ServerExited(code));
            })))?;
            let info = sidecar.wait_ready(READY_TIMEOUT).map_err(|e| {
                sidecar.stop();
                e
            })?;
            Ok((Arc::new(sidecar), info.port, tok))
        };
        match run() {
            Ok((sidecar, port, tok)) => {
                // Sidecar diserahkan ke thread GTK lewat kanal statis agar `Msg` tetap Send.
                SIDECAR_SLOT.lock().unwrap().replace(sidecar);
                let _ = tx.send(Msg::Ready { port, token: tok });
            }
            Err(e) => {
                let _ = tx.send(Msg::Failed(e));
            }
        }
    });
}

static SIDECAR_SLOT: std::sync::Mutex<Option<Arc<Sidecar>>> = std::sync::Mutex::new(None);

fn build(app: &gtk::Application) {
    if let Some(existing) = app.windows().first() {
        existing.present();
        return;
    }
    gtk::Window::set_default_icon_name("jejak");
    let window = gtk::ApplicationWindow::new(app);
    window.set_title("Jejak");
    window.set_default_size(1280, 820);
    window.set_size_request(900, 600);

    let notify: Box<dyn Fn(&str, &str) + Send + Sync> = Box::new(|title, body| {
        let _ = Command::new("notify-send").args(["--app-name=Jejak", title, body]).spawn();
    });
    let bridge = Arc::new(Bridge::new(notify));
    let port = Rc::new(Cell::new(0u16));
    let web = build_web(bridge, port.clone());

    let splash_label = gtk::Label::new(None);
    let splash = gtk::Box::new(gtk::Orientation::Vertical, 0);
    splash.set_valign(gtk::Align::Center);
    splash.add(&splash_label);

    let error_label = gtk::Label::new(None);
    let error_text = gtk::TextView::new();
    error_text.set_editable(false);
    error_text.set_wrap_mode(gtk::WrapMode::WordChar);
    let scroll = gtk::ScrolledWindow::new(gtk::Adjustment::NONE, gtk::Adjustment::NONE);
    scroll.set_min_content_height(200);
    scroll.add(&error_text);
    let retry = gtk::Button::with_label(&l("button.retry", "Coba lagi", &[]));
    let copy = gtk::Button::with_label(&l("button.copy", "Salin", &[]));
    let buttons = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    buttons.set_halign(gtk::Align::Center);
    buttons.add(&retry);
    buttons.add(&copy);
    let error_box = gtk::Box::new(gtk::Orientation::Vertical, 12);
    error_box.set_valign(gtk::Align::Center);
    error_box.set_margin(24);
    error_box.add(&error_label);
    error_box.add(&scroll);
    error_box.add(&buttons);

    let stack = gtk::Stack::new();
    stack.add_named(&splash, "splash");
    stack.add_named(&error_box, "error");
    stack.add_named(&web, "web");
    window.add(&stack);

    let ui = Rc::new(Ui {
        window: window.clone(),
        stack,
        splash_label,
        error_label,
        error_text: error_text.clone(),
        web: web.clone(),
        port: Cell::new(0),
        sidecar: RefCell::new(None),
        closing: Cell::new(false),
    });

    #[allow(deprecated)]
    let (tx, rx) = glib::MainContext::channel::<Msg>(glib::Priority::DEFAULT);
    {
        let ui = ui.clone();
        let port = port.clone();
        let app = app.clone();
        rx.attach(None, move |msg| {
            match msg {
                Msg::Ready { port: p, token: tok } => {
                    port.set(p);
                    ui.port.set(p);
                    *ui.sidecar.borrow_mut() = SIDECAR_SLOT.lock().unwrap().take();
                    ui.web.load_uri(&navigation::enter_url(p, &tok));
                }
                Msg::Quit => app.quit(),
                Msg::Failed(e) => show_error(&ui, &e),
                Msg::ServerExited(code) => {
                    if !ui.closing.get() {
                        let detail = ui.sidecar.borrow().as_ref().map(|s| s.stderr.summary(40)).unwrap_or_default();
                        let head = l("error.server_exited", "Server Jejak berhenti tiba-tiba (kode %@)", &[&code.to_string()]);
                        show_error(&ui, &if detail.is_empty() { head } else { format!("{head}\n\n{detail}") });
                    }
                }
            }
            glib::ControlFlow::Continue
        });
    }

    // Tampilkan halaman web begitu Jejak sendiri selesai dimuat.
    {
        let ui = ui.clone();
        web.connect_load_changed(move |web, event| {
            if event == LoadEvent::Finished
                && web.uri().map(|u| navigation::is_local_app_url(u.as_str(), ui.port.get())).unwrap_or(false)
            {
                show(&ui, "web");
            }
        });
    }

    {
        let ui = ui.clone();
        let tx = tx.clone();
        retry.connect_clicked(move |_| {
            *ui.sidecar.borrow_mut() = None;
            start(&ui, tx.clone());
        });
    }
    {
        let text = error_text.clone();
        copy.connect_clicked(move |b| {
            if let Some(buf) = text.buffer() {
                let (s, e) = buf.bounds();
                let content = buf.text(&s, &e, false);
                gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).set_text(content.as_ref().map(|c| c.as_str()).unwrap_or(""));
            }
            let _ = b;
        });
    }

    // Tutup: hentikan sidecar di luar thread UI, lalu keluar.
    {
        let ui = ui.clone();
        let tx = tx.clone();
        window.connect_delete_event(move |w, _| {
            if ui.closing.get() {
                return glib::Propagation::Proceed;
            }
            ui.closing.set(true);
            w.hide();
            let sidecar = ui.sidecar.borrow_mut().take();
            let tx = tx.clone();
            std::thread::spawn(move || {
                if let Some(s) = sidecar {
                    s.stop();
                }
                let _ = tx.send(Msg::Quit);
            });
            glib::Propagation::Stop
        });
    }
    // SIGTERM/SIGINT: sama dengan menutup jendela.
    for sig in [libc::SIGTERM, libc::SIGINT] {
        let win = ui.window.clone();
        glib::unix_signal_add_local(sig, move || {
            win.close();
            glib::ControlFlow::Break
        });
    }

    window.show_all();
    start(&ui, tx);
}

fn main() -> glib::ExitCode {
    // WM_CLASS / nama di taskbar: tanpa ini GTK memakai argv[0] (`jejak-desktop` lewat symlink deb).
    glib::set_prgname(Some("Jejak"));
    glib::set_application_name("Jejak");
    let app = gtk::Application::builder().application_id("io.github.jejak-dev.jejak.native").build();
    app.connect_activate(build);
    app.run()
}
