//! Daftar putih navigasi: hanya http://127.0.0.1:<port>.

pub const LOOPBACK: &str = "127.0.0.1";
pub const ENTER_PATH: &str = "/__desktop/enter";

pub fn enter_url(port: u16, token: &str) -> String {
    format!("http://{LOOPBACK}:{port}{ENTER_PATH}?t={token}")
}

/// (skema, host, port) dari URL absolut sederhana; `None` bila bukan bentuk itu.
fn split(url: &str) -> Option<(String, String, Option<u16>)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') {
        return None; // userinfo: tak dipakai oleh Jejak, tolak
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => (h, Some(p.parse::<u16>().ok()?)),
        _ => (authority, None),
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase(), port))
}

pub fn is_local_app_url(url: &str, port: u16) -> bool {
    if port == 0 {
        return false;
    }
    matches!(split(url), Some((s, h, Some(p))) if s == "http" && h == LOOPBACK && p == port)
}

pub fn is_allowed_navigation(url: &str, port: u16) -> bool {
    url == "about:blank" || is_local_app_url(url, port)
}

/// Tautan http/https bukan Jejak sendiri → boleh dibuka di browser sistem.
pub fn external_open_target(url: &str, port: u16) -> Option<String> {
    let (scheme, _, _) = split(url)?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if is_local_app_url(url, port) {
        return None;
    }
    Some(url.to_string())
}
