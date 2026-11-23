import Foundation
import Security

/// Token masuk sekali pakai antara cangkang dan server. Hanya hidup di memori.
public enum DesktopToken {
  /// Panjang minimal token yang diterima server (karakter).
  public static let minimumLength = 32

  /// 32 byte acak base64url tanpa padding (43 karakter).
  public static func generate() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw ReadyLineError(description: "tak bisa membuat token acak (kode \(status))")
    }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Sah bila cukup panjang dan hanya berisi `A-Za-z0-9_-`.
  public static func isValid(_ token: String) -> Bool {
    guard token.count >= minimumLength else { return false }
    return token.utf8.allSatisfy { byte in
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
        || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
    }
  }
}
