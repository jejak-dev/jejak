//! Pengelola proses sidecar `jejak serve --desktop`: process group sendiri,
//! stdin terbuka (menutupnya = sinyal berhenti), token hanya lewat lingkungan.

use crate::l10n::l;
use crate::ready_line::{self, ReadyInfo};
use crate::ring::LineRing;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const READY_TIMEOUT: Duration = Duration::from_secs(30);
pub const EXIT_GRACE: Duration = Duration::from_secs(3);

#[derive(Default)]
struct State {
    ready: Option<ReadyInfo>,
    failure: Option<String>,
    exited: bool,
    stopped: bool,
    exit_code: Option<i32>,
}

pub struct Sidecar {
    pid: i32,
    stdin: Mutex<Option<ChildStdin>>,
    state: Arc<(Mutex<State>, Condvar)>,
    pub stderr: Arc<LineRing>,
}

type ExitHandler = Box<dyn Fn(i32) + Send + 'static>;

impl Sidecar {
    /// `on_unexpected_exit` dipanggil sekali bila proses berhenti SETELAH siap dan bukan karena `stop()`.
    pub fn start(
        binary: &Path,
        token: &str,
        extra_env: &[(String, String)],
        on_unexpected_exit: Option<ExitHandler>,
    ) -> Result<Sidecar, String> {
        let mut cmd = Command::new(binary);
        cmd.args(["serve", "--desktop"])
            .env("JEJAK_DESKTOP_TOKEN", token)
            .env("PORT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0); // pgid == pid: stop() mematikan seluruh pohon
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        // ETXTBSY ("Text file busy"): biner baru saja ditulis dan fork thread lain masih memegang
        // fd tulisnya sesaat (mis. setelah pembaruan, atau uji paralel). Coba lagi sebentar.
        let mut attempt = 0;
        let mut child: Child = loop {
            match cmd.spawn() {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && attempt < 20 => {
                    attempt += 1;
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => {
                    return Err(l("sidecar.spawn", "gagal menjalankan sidecar %@: %@", &[&binary.display().to_string(), &e.to_string()]));
                }
            }
        };
        let pid = child.id() as i32;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr_pipe = child.stderr.take().expect("stderr piped");
        let state: Arc<(Mutex<State>, Condvar)> = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let ring = Arc::new(LineRing::new(200));

        let out_state = state.clone();
        let out_thread = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let (m, cv) = &*out_state;
                let mut s = m.lock().unwrap();
                if s.ready.is_some() || s.failure.is_some() {
                    continue; // terus kuras pipa
                }
                match ready_line::parse(&line) {
                    Ok(Some(info)) => s.ready = Some(info),
                    Ok(None) => continue,
                    Err(e) => s.failure = Some(e),
                }
                cv.notify_all();
            }
        });
        let ring2 = ring.clone();
        let err_thread = std::thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
                ring2.append(line);
            }
        });
        let wait_state = state.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let code = status
                .ok()
                .map(|s| {
                    use std::os::unix::process::ExitStatusExt;
                    s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))
                })
                .unwrap_or(-1);
            let _ = out_thread.join();
            let _ = err_thread.join();
            let (m, cv) = &*wait_state;
            let (was_ready, intentional) = {
                let mut s = m.lock().unwrap();
                s.exited = true;
                s.exit_code = Some(code);
                if s.ready.is_none() && s.failure.is_none() {
                    s.failure = Some(l("sidecar.exited_before_ready", "Server Jejak berhenti sebelum siap", &[]));
                }
                (s.ready.is_some(), s.stopped)
            };
            cv.notify_all();
            if was_ready && !intentional {
                if let Some(h) = on_unexpected_exit {
                    h(code);
                }
            }
        });

        Ok(Sidecar { pid, stdin: Mutex::new(stdin), state, stderr: ring })
    }

    pub fn is_running(&self) -> bool {
        !self.state.0.lock().unwrap().exited
    }

    /// Menunggu baris JEJAK_READY (blokir thread pemanggil). Galat memuat ringkasan stderr.
    pub fn wait_ready(&self, timeout: Duration) -> Result<ReadyInfo, String> {
        let (m, cv) = &*self.state;
        let deadline = Instant::now() + timeout;
        let mut s = m.lock().unwrap();
        loop {
            if let Some(info) = s.ready.clone() {
                return Ok(info);
            }
            if let Some(f) = s.failure.clone() {
                drop(s);
                return Err(self.with_stderr(f));
            }
            let now = Instant::now();
            if now >= deadline {
                drop(s);
                return Err(self.with_stderr(l(
                    "sidecar.timeout",
                    "Server Jejak tak siap dalam %@ detik",
                    &[&timeout.as_secs().to_string()],
                )));
            }
            s = cv.wait_timeout(s, deadline - now).unwrap().0;
        }
    }

    fn with_stderr(&self, message: String) -> String {
        // Beri pembaca stderr sekejap untuk menguras sisa keluaran.
        std::thread::sleep(Duration::from_millis(50));
        let tail = self.stderr.summary(40);
        if tail.is_empty() { message } else { format!("{message}\n{tail}") }
    }

    fn wait_exit(&self, span: Duration) -> bool {
        let (m, cv) = &*self.state;
        let deadline = Instant::now() + span;
        let mut s = m.lock().unwrap();
        while !s.exited {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            s = cv.wait_timeout(s, deadline - now).unwrap().0;
        }
        true
    }

    /// Menutup stdin, menunggu, lalu mematikan SELURUH grup proses. Idempoten.
    pub fn stop(&self) {
        {
            let mut s = self.state.0.lock().unwrap();
            if s.stopped {
                return;
            }
            s.stopped = true;
        }
        drop(self.stdin.lock().unwrap().take());
        if !self.wait_exit(EXIT_GRACE) {
            unsafe { libc::killpg(self.pid, libc::SIGTERM) };
            if !self.wait_exit(Duration::from_secs(2)) {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                self.wait_exit(Duration::from_secs(1));
            }
        }
        // Anak langsung sudah selesai; pastikan sisa grup (cucu) juga mati.
        unsafe {
            libc::killpg(self.pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(100));
        unsafe {
            libc::killpg(self.pid, libc::SIGKILL);
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}
