use crate::l10n::l;

pub const PREFIX: &str = "JEJAK_READY";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyInfo {
    pub port: u16,
    pub host: String,
    pub version: String,
}

/// `Ok(None)` = bukan pengumuman; `Err` = pengumuman dengan payload rusak.
pub fn parse(line: &str) -> Result<Option<ReadyInfo>, String> {
    let clean = line.trim_end_matches(['\r', '\n']);
    let Some(rest) = clean.strip_prefix(PREFIX) else { return Ok(None) };
    let no_payload = || l("ready.no_payload", "baris JEJAK_READY tanpa payload JSON", &[]);
    let Some(first) = rest.chars().next() else { return Err(no_payload()) };
    if !first.is_whitespace() {
        return Ok(None);
    }
    let body = rest.trim();
    if body.is_empty() {
        return Err(no_payload());
    }
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| l("ready.bad_json", "payload JEJAK_READY bukan JSON yang sah", &[]))?;
    let obj = value
        .as_object()
        .ok_or_else(|| l("ready.bad_json", "payload JEJAK_READY bukan JSON yang sah", &[]))?;
    let port = obj
        .get("port")
        .and_then(|p| p.as_i64())
        .ok_or_else(|| l("ready.no_port", "payload JEJAK_READY tanpa port", &[]))?;
    if !(1..=65535).contains(&port) {
        return Err(l("ready.port_range", "port JEJAK_READY di luar rentang: %@", &[&port.to_string()]));
    }
    Ok(Some(ReadyInfo {
        port: port as u16,
        host: obj.get("host").and_then(|h| h.as_str()).unwrap_or("127.0.0.1").to_string(),
        version: obj.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    }))
}
