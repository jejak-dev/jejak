import Foundation

/// Daftar putih navigasi webview utama.
public enum NavigationPolicy {
  public static let loopback = "127.0.0.1"
  public static let enterPath = "/__desktop/enter"

  /// URL masuk sekali pakai untuk port tertentu.
  public static func enterURL(port: UInt16, token: String) -> String {
    "http://\(loopback):\(port)\(enterPath)?t=\(token)"
  }

  /// True bila URL adalah server Jejak di loopback pada port yang dipakai.
  public static func isLocalAppURL(_ url: String, port: UInt16) -> Bool {
    guard port != 0, let komponen = URLComponents(string: url) else { return false }
    return komponen.scheme == "http" && komponen.host == loopback && komponen.port == Int(port)
  }

  /// URL boleh dimuat di webview utama (selain itu ditolak).
  public static func isAllowedNavigation(_ url: String, port: UInt16) -> Bool {
    // Halaman kosong dipakai WKWebView untuk muatan internal.
    if url == "about:blank" { return true }
    return isLocalAppURL(url, port: port)
  }

  /// URL yang pantas dibuka di browser sistem: tautan http/https yang bukan
  /// halaman Jejak sendiri. Skema lain (file, javascript, data, ...) `nil`.
  public static func externalOpenTarget(_ url: String, port: UInt16) -> String? {
    guard let komponen = URLComponents(string: url),
      let skema = komponen.scheme?.lowercased(),
      skema == "http" || skema == "https",
      komponen.host != nil
    else { return nil }
    if isLocalAppURL(url, port: port) { return nil }
    return url
  }
}
