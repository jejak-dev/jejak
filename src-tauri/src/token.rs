//! Token masuk sekali pakai untuk mode desktop.
//!
//! Token dibuat dari 32 byte acak lalu disandikan base64url tanpa padding
//! supaya hanya berisi huruf, angka, `-`, dan `_` (syarat server Jejak).

/// Huruf base64url (tanpa padding).
const ABECEDE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Jumlah byte acak untuk satu token.
const BITA_ACAK: usize = 32;

/// Panjang minimal token (karakter) yang diminta server.
pub const PANJANG_MINIMUM: usize = 32;

/// Sandikan byte menjadi base64url tanpa padding.
pub fn base64url_tanpa_padding(data: &[u8]) -> String {
  let mut hasil = String::with_capacity(data.len().div_ceil(3) * 4);
  for inti in data.chunks(3) {
    let b0 = u32::from(inti[0]);
    let b1 = u32::from(*inti.get(1).unwrap_or(&0));
    let b2 = u32::from(*inti.get(2).unwrap_or(&0));
    let nilai = (b0 << 16) | (b1 << 8) | b2;
    hasil.push(ABECEDE[((nilai >> 18) & 63) as usize] as char);
    hasil.push(ABECEDE[((nilai >> 12) & 63) as usize] as char);
    if inti.len() > 1 {
      hasil.push(ABECEDE[((nilai >> 6) & 63) as usize] as char);
    }
    if inti.len() > 2 {
      hasil.push(ABECEDE[(nilai & 63) as usize] as char);
    }
  }
  hasil
}

/// Buat token acak untuk masuk sekali pakai ke sidecar.
pub fn generate_token() -> Result<String, String> {
  let mut byte = [0u8; BITA_ACAK];
  getrandom::fill(&mut byte).map_err(|galat| format!("gagal membuat token acak: {galat}"))?;
  Ok(base64url_tanpa_padding(&byte))
}

/// True bila token memenuhi syarat server (panjang dan karakter sah).
pub fn token_sah(token: &str) -> bool {
  token.len() >= PANJANG_MINIMUM
    && token
      .bytes()
      .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Timpa isi string dengan nol lalu kosongkan (pembuangan token dari memori).
pub fn wipe(nilai: &mut String) {
  // `as_mut_vec`tak aman secara umum, tapi aman di sini: isinya hanya ASCII
  // base64url dan string langsung dikosongkan sesudahnya.
  unsafe { nilai.as_mut_vec() }.fill(0);
  nilai.clear();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn token_panjang_sah_dan_karakter_sah() {
    let token = generate_token().expect("token harus bisa dibuat");
    assert!(token.len() >= PANJANG_MINIMUM, "panjang token: {}", token.len());
    assert!(token_sah(&token), "token: {token}");
  }

  #[test]
  fn dua_panggilan_token_berbeda() {
    let satu = generate_token().expect("token pertama");
    let dua = generate_token().expect("token kedua");
    assert_ne!(satu, dua);
  }

  #[test]
  fn base64url_tanpa_padding_tanpa_karakter_asing() {
    let hasil = base64url_tanpa_padding(&[0xff, 0xfe, 0xfd, 0x00, 0x01]);
    assert!(!hasil.contains('='), "hasil: {hasil}");
    assert!(!hasil.contains('+'), "hasil: {hasil}");
    assert!(!hasil.contains('/'), "hasil: {hasil}");
    // Semua karakter hasil harus boleh dipakai di token.
    assert!(
      hasil.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
      "hasil: {hasil}",
    );
  }

  #[test]
  fn base64url_panjang_genap_tanpa_padding() {
    let hasil = base64url_tanpa_padding(&[1, 2]);
    assert_eq!(hasil.len(), 3);
  }

  #[test]
  fn token_sah_menolak_token_terlalu_panjang_pendek_dan_karakter_asing() {
    assert!(!token_sah("pendek"));
    assert!(!token_sah("token dengan spasi dan tanda Plus+"));
    assert!(token_sah(&"a".repeat(PANJANG_MINIMUM)));
  }

  #[test]
  fn wipe_mengosongkan_string() {
    let mut nilai = String::from("rahasia");
    wipe(&mut nilai);
    assert!(nilai.is_empty());
  }
}
