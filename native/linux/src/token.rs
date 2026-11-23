use crate::l10n::l;
use std::io::Read;

pub const MIN_LENGTH: usize = 32;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url tanpa padding.
pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

/// 32 byte acak dari /dev/urandom, base64url (43 karakter).
pub fn generate() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| l("token.random", "tak bisa membuat token acak: %@", &[&e.to_string()]))?;
    Ok(base64url(&bytes))
}

pub fn is_valid(token: &str) -> bool {
    token.len() >= MIN_LENGTH && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
