import Foundation
@testable import JejakShellCore

// Fixture: kunci uji sekali pakai + berkas "hello-update\n" yang ditandatangani
// dengan `tauri signer sign` (varian ED). Kunci privatnya dibuang.
let kunciUji = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhCQTI4NEEwRjgwNDAyRkIKUldUN0FnVDRvSVNpaXdtZFZUckcxU0NvT05LeVorbERaVEF6YlFXWCtIWVJkVDh1YjVTMGlxanQK"
let sigUji = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUN0FnVDRvSVNpaXdZeG53K1VpTlB2aCtSM3JMT3pYejdnL2w4VHNwR3haYlR0c0s2K0tVbzlDd0RmcmN4OHJzdmx6Skl4STA2YlpVNUpsRk5zUmJibjRkZ0N0d1lWZkFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NDE0MzYzCWZpbGU6YS5iaW4Kc0c0cFZUU0F5ZHBGM0M1Sm1STnhHZXZJWmh5dzBLa0sxN24zZUFkdVFWRitiVmJnYVYxVmpDRDVnMy9tMXF2MG1qU1BMNTMvTUpOUEtEZEdoUm1UQ3c9PQo="

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

struct Blake2bTests {
  func vektorResmi() {
    expect(hex(Blake2b.hash(Data())) == "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce")
    expect(hex(Blake2b.hash(Data("abc".utf8))) == "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923")
  }
  /// Streaming harus sama dengan sekali jalan, termasuk di batas blok 128 byte.
  func streamingSamaDenganSekaliJalan() {
    for ukuran in [1, 127, 128, 129, 255, 256, 257, 1000, 4096] {
      let data = Data((0..<ukuran).map { UInt8($0 & 0xff) })
      var b = Blake2b()
      var i = 0
      while i < data.count { let n = min(37, data.count - i); b.update(data.subdata(in: i..<i + n)); i += n }
      expect(hex(b.finalize()) == hex(Blake2b.hash(data)))
    }
  }
  /// Vektor dari hashlib Python untuk 200 byte 0..199.
  func vektorBlokJamak() {
    let data = Data((0..<200).map { UInt8($0) })
    expect(hex(Blake2b.hash(data)) == "fb3c1f0f56a56f8e316fdf5d853c8c872c39635d083634c3904fc3ac07d1b578e85ff0e480e92d44ade33b62e893ee32343e79ddf6ef292e89b582d312502314")
    let dua = Data((0..<256).map { UInt8($0) })
    expect(hex(Blake2b.hash(dua)) == "1ecc896f34d3f9cac484c73f75f6a5fb58ee6784be41b35f46067b9c65c63a6794d3d744112c653f73dd7deb6666204c5a9bfa5b46081fc10fdbe7884fa5cbf8")
  }
}

struct MinisignTests {
  let isi = Data("hello-update\n".utf8)
  func berkasSahLolos() throws {
    let k = try MinisignPublicKey(base64Tauri: kunciUji)
    try k.verify(data: isi, signatureBase64: sigUji)
  }
  func berkasDiubahDitolak() throws {
    let k = try MinisignPublicKey(base64Tauri: kunciUji)
    expectThrows { try k.verify(data: Data("hello-update!\n".utf8), signatureBase64: sigUji) }
  }
  func kunciLainDitolak() throws {
    // Kunci Jejak asli (tauri.conf.json) berbeda dari kunci uji.
    let asli = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM3MjcyOUI5QzhFRDExMzAKUldRd0VlM0l1U2tuTjZ3R1BBZjNwVzl2OXROakVZMUwwbmtpNWw4T0ZNbVZNNS9lajd1VnlZNVoK"
    let k = try MinisignPublicKey(base64Tauri: asli)
    expectThrows { try k.verify(data: isi, signatureBase64: sigUji) }
  }
  func trustedCommentDiubahDitolak() throws {
    let k = try MinisignPublicKey(base64Tauri: kunciUji)
    let teks = String(data: Data(base64Encoded: sigUji)!, encoding: .utf8)!
    let rusak = teks.replacingOccurrences(of: "file:a.bin", with: "file:b.bin")
    expect(rusak != teks)
    expectThrows { try k.verify(data: isi, signatureBase64: Data(rusak.utf8).base64EncodedString()) }
  }
  func masukanRusakDitolak() {
    expectThrows { try MinisignPublicKey(base64Tauri: "bukan-base64!") }
    expectThrows { try MinisignPublicKey(base64Tauri: Data("a\nb".utf8).base64EncodedString()) }
  }
  func berkasDariDisk() throws {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("mini-\(UUID().uuidString)")
    try isi.write(to: u); defer { try? FileManager.default.removeItem(at: u) }
    try MinisignPublicKey(base64Tauri: kunciUji).verify(file: u, signatureBase64: sigUji)
  }
}

struct SemverTests {
  func urutan() {
    func v(_ s: String) -> Semver { Semver(s)! }
    expect(v("0.1.0-beta.19") < v("0.1.0-beta.20"))
    expect(v("0.1.0-beta.9") < v("0.1.0-beta.10"))  // numerik, bukan leksikal
    expect(v("0.1.0-beta.20") < v("0.1.0"))
    expect(v("0.1.0") < v("0.1.1"))
    expect(v("0.9.0") < v("0.10.0"))
    expect(v("1.0.0-alpha") < v("1.0.0-alpha.1"))
    expect(v("1.0.0-alpha.1") < v("1.0.0-beta"))
    expect(v("1.0.0-1") < v("1.0.0-alpha"))
    expect(!(v("0.1.0-beta.19") < v("0.1.0-beta.19")))
    expect(v("v1.2.3") == v("1.2.3+build5"))
  }
  func tidakSah() {
    for s in ["", "1", "1.2", "a.b.c", "1.2.3-", "1.2.3-a..b", "-1.0.0"] { expect(Semver(s) == nil) }
  }
}
