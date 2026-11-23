import Foundation

/// Awalan baris pengumuman server siap (baca mesin).
public let readyPrefix = "JEJAK_READY"

/// Informasi dari baris pengumuman server siap.
public struct ReadyInfo: Equatable, Sendable {
  public let port: UInt16
  public let host: String
  public let version: String
}

/// Galat pengurai baris siap.
public struct ReadyLineError: Error, Equatable, CustomStringConvertible {
  public let description: String
}

public enum ReadyLine {
  /// Membaca satu baris stdout sidecar.
  ///
  /// `nil` berarti baris itu bukan pengumuman (diabaikan); `throw` berarti
  /// baris pengumuman tetapi payload-nya rusak.
  public static func parse(_ baris: String) throws -> ReadyInfo? {
    let bersih = baris.trimmingCharacters(in: CharacterSet(charactersIn: "\r\n"))
    guard bersih.hasPrefix(readyPrefix) else { return nil }
    let sisa = bersih.dropFirst(readyPrefix.count)
    guard let pertama = sisa.first else {
      throw ReadyLineError(description: "baris JEJAK_READY tanpa payload JSON")
    }
    // "JEJAK_READYX" bukan pengumuman.
    guard pertama.isWhitespace else { return nil }
    let isi = sisa.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !isi.isEmpty else {
      throw ReadyLineError(description: "baris JEJAK_READY tanpa payload JSON")
    }
    guard
      let data = isi.data(using: .utf8),
      let objek = try? JSONSerialization.jsonObject(with: data),
      let kamus = objek as? [String: Any]
    else {
      throw ReadyLineError(description: "payload JEJAK_READY bukan JSON yang sah")
    }
    guard let angka = kamus["port"] as? NSNumber, CFGetTypeID(angka) != CFBooleanGetTypeID() else {
      throw ReadyLineError(description: "payload JEJAK_READY tanpa port")
    }
    let port = angka.int64Value
    guard port > 0, port <= Int64(UInt16.max) else {
      throw ReadyLineError(description: "port JEJAK_READY di luar rentang: \(port)")
    }
    return ReadyInfo(
      port: UInt16(port),
      host: (kamus["host"] as? String) ?? "127.0.0.1",
      version: (kamus["version"] as? String) ?? ""
    )
  }
}
