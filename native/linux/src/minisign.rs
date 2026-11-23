//! Verifikasi tanda tangan minisign dari `tauri signer`. Hanya varian "ED" (berkas
//! di-prehash BLAKE2b-512), sama dengan plugin updater Tauri dan cangkang macOS/Windows.
//! Kunci publik dan tanda tangan berupa base64 dari isi berkas `.pub` / `.sig`.

use crate::l10n::l;
use base64::{engine::general_purpose::STANDARD, Engine};
use blake2::{Blake2b512, Digest};
use ed25519_dalek::{Signature, VerifyingKey};
use std::io::Read;
use std::path::Path;

pub struct PublicKey {
    key_id: [u8; 8],
    key: VerifyingKey,
}

fn bad_format() -> String {
    l("sign.bad_format", "format tanda tangan pembaruan rusak", &[])
}

/// Base64 luar → teks minisign → baris.
fn decode_text(b64: &str) -> Result<Vec<String>, String> {
    let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
    let raw = STANDARD.decode(clean).map_err(|_| bad_format())?;
    let text = String::from_utf8(raw).map_err(|_| bad_format())?;
    Ok(text.split('\n').map(str::to_string).collect())
}

fn b64(s: &str) -> Option<Vec<u8>> {
    STANDARD.decode(s.trim()).ok()
}

impl PublicKey {
    pub fn from_base64(b64_tauri: &str) -> Result<PublicKey, String> {
        let bad = || l("sign.bad_pubkey", "kunci publik pembaruan tak sah", &[]);
        let lines = decode_text(b64_tauri).map_err(|_| bad())?;
        let raw = lines.get(1).and_then(|x| b64(x)).ok_or_else(bad)?;
        if raw.len() != 42 || raw[0] != 0x45 || raw[1] != 0x64 {
            return Err(bad()); // "Ed"
        }
        let mut key_id = [0u8; 8];
        key_id.copy_from_slice(&raw[2..10]);
        let bytes: [u8; 32] = raw[10..42].try_into().map_err(|_| bad())?;
        let key = VerifyingKey::from_bytes(&bytes).map_err(|_| bad())?;
        Ok(PublicKey { key_id, key })
    }

    pub fn verify_file(&self, path: &Path, signature_b64: &str) -> Result<(), String> {
        let read_err = || l("sign.read", "berkas unduhan tak bisa dibaca", &[]);
        let mut f = std::fs::File::open(path).map_err(|_| read_err())?;
        let mut hasher = Blake2b512::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(|_| read_err())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        self.verify_digest(&hasher.finalize(), signature_b64)
    }

    pub fn verify_data(&self, data: &[u8], signature_b64: &str) -> Result<(), String> {
        self.verify_digest(&Blake2b512::digest(data), signature_b64)
    }

    fn verify_digest(&self, digest: &[u8], signature_b64: &str) -> Result<(), String> {
        let invalid = || l("sign.invalid", "tanda tangan pembaruan tak cocok", &[]);
        let lines = decode_text(signature_b64)?;
        // [0] komentar, [1] tanda tangan, [2] "trusted comment: ...", [3] tanda tangan global
        if lines.len() < 4 {
            return Err(bad_format());
        }
        let raw = b64(&lines[1]).filter(|r| r.len() == 74).ok_or_else(bad_format)?;
        let global = b64(&lines[3]).filter(|g| g.len() == 64).ok_or_else(bad_format)?;
        if raw[0] != 0x45 || raw[1] != 0x44 {
            return Err(l("sign.legacy", "tanda tangan varian lama tak diterima", &[]));
        }
        if raw[2..10] != self.key_id {
            return Err(l("sign.wrong_key", "tanda tangan dibuat dengan kunci lain", &[]));
        }
        let sig_bytes: [u8; 64] = raw[10..74].try_into().map_err(|_| bad_format())?;
        let sig = Signature::from_bytes(&sig_bytes);
        self.key.verify_strict(digest, &sig).map_err(|_| invalid())?;
        // Tanda tangan global melindungi trusted comment: sig || komentar.
        let comment = lines[2].strip_prefix("trusted comment: ").ok_or_else(bad_format)?;
        let mut msg = sig_bytes.to_vec();
        msg.extend_from_slice(comment.as_bytes());
        let gsig = Signature::from_bytes(&global.try_into().map_err(|_| bad_format())?);
        self.key.verify_strict(&msg, &gsig).map_err(|_| invalid())
    }
}
