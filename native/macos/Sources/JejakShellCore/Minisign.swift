import CryptoKit
import Foundation

/// Galat verifikasi tanda tangan pembaruan.
public struct MinisignError: Error, CustomStringConvertible, Equatable {
  public let description: String
}

/// Verifikasi tanda tangan format minisign yang dihasilkan `tauri signer`.
///
/// Varian yang diterima hanya "ED" (berkas di-prehash BLAKE2b-512), sama dengan
/// plugin updater Tauri (`allow_legacy = false`). Kunci publik dan tanda tangan
/// dikirim sebagai base64 dari isi berkas `.pub` / `.sig` (teks minisign utuh).
public struct MinisignPublicKey {
  private let keyID: Data
  private let key: Curve25519.Signing.PublicKey

  /// - Parameter base64Tauri: isi `tauri.conf.json > plugins.updater.pubkey`.
  public init(base64Tauri: String) throws {
    let baris = try Self.decodeTeks(base64Tauri)
    guard baris.count >= 2, let mentah = Data(base64Encoded: baris[1]), mentah.count == 42,
      mentah[0] == 0x45, mentah[1] == 0x64  // "Ed"
    else { throw MinisignError(description: L("sign.bad_pubkey", "kunci publik pembaruan tak sah")) }
    keyID = mentah.subdata(in: 2..<10)
    do {
      key = try Curve25519.Signing.PublicKey(rawRepresentation: mentah.subdata(in: 10..<42))
    } catch {
      throw MinisignError(description: L("sign.bad_pubkey", "kunci publik pembaruan tak sah"))
    }
  }

  /// Memverifikasi berkas terhadap tanda tangan; melempar bila ada yang tak cocok.
  public func verify(file: URL, signatureBase64: String) throws {
    var hasher = Blake2b()
    guard let handle = try? FileHandle(forReadingFrom: file) else {
      throw MinisignError(description: L("sign.read", "berkas unduhan tak bisa dibaca"))
    }
    defer { try? handle.close() }
    while let potong = try? handle.read(upToCount: 1 << 20), !potong.isEmpty {
      hasher.update(potong)
    }
    try verify(digest: hasher.finalize(), signatureBase64: signatureBase64)
  }

  public func verify(data: Data, signatureBase64: String) throws {
    try verify(digest: Blake2b.hash(data), signatureBase64: signatureBase64)
  }

  private func verify(digest: Data, signatureBase64: String) throws {
    let salah = MinisignError(description: L("sign.invalid", "tanda tangan pembaruan tak cocok"))
    let baris = try Self.decodeTeks(signatureBase64)
    // [0] komentar, [1] tanda tangan, [2] "trusted comment: ...", [3] tanda tangan global
    guard baris.count >= 4, let mentah = Data(base64Encoded: baris[1]), mentah.count == 74,
      let global = Data(base64Encoded: baris[3]), global.count == 64
    else { throw MinisignError(description: L("sign.bad_format", "format tanda tangan pembaruan rusak")) }
    guard mentah[0] == 0x45, mentah[1] == 0x44 else {
      throw MinisignError(description: L("sign.legacy", "tanda tangan varian lama tak diterima"))
    }
    guard mentah.subdata(in: 2..<10) == keyID else {
      throw MinisignError(description: L("sign.wrong_key", "tanda tangan dibuat dengan kunci lain"))
    }
    let tanda = mentah.subdata(in: 10..<74)
    guard key.isValidSignature(tanda, for: digest) else { throw salah }
    // Tanda tangan global melindungi trusted comment: sig || komentar.
    let prefiks = "trusted comment: "
    guard baris[2].hasPrefix(prefiks) else {
      throw MinisignError(description: L("sign.bad_format", "format tanda tangan pembaruan rusak"))
    }
    let komentar = Data(baris[2].dropFirst(prefiks.count).utf8)
    guard key.isValidSignature(global, for: tanda + komentar) else { throw salah }
  }

  /// Base64 luar → teks minisign → baris.
  private static func decodeTeks(_ base64: String) throws -> [String] {
    let bersih = base64.filter { !$0.isWhitespace }
    guard let data = Data(base64Encoded: bersih), let teks = String(data: data, encoding: .utf8) else {
      throw MinisignError(description: L("sign.bad_format", "format tanda tangan pembaruan rusak"))
    }
    return teks.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }
}
