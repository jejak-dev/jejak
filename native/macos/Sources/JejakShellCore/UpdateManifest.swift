import Foundation

/// Manifest pembaruan (`latest.json`, format statis Tauri v2).
public struct UpdateManifest: Equatable, Sendable {
  public struct Platform: Equatable, Sendable {
    public let url: URL
    public let signature: String
  }
  public let version: Semver
  public let notes: String?
  public let date: String?
  public let platforms: [String: Platform]

  /// Kunci platform untuk cangkang native. Sengaja berbeda dari kunci Tauri
  /// (`darwin-aarch64` / `darwin-aarch64-app`) supaya cangkang native tak pernah
  /// memasang artefak Tauri (yang berisi aplikasi lain) dan sebaliknya.
  public static func nativePlatformKey() -> String {
    #if arch(arm64)
    "darwin-aarch64-native"
    #else
    "darwin-x86_64-native"
    #endif
  }

  public static func parse(_ data: Data) throws -> UpdateManifest {
    let bad = MinisignError(description: L("manifest.bad", "manifest pembaruan rusak"))
    guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let verTeks = obj["version"] as? String, let ver = Semver(verTeks)
    else { throw bad }
    var platforms: [String: Platform] = [:]
    if let raw = obj["platforms"] as? [String: Any] {
      for (k, v) in raw {
        guard let p = v as? [String: Any], let u = p["url"] as? String, let url = URL(string: u),
          let sig = p["signature"] as? String, !sig.isEmpty
        else { continue }
        platforms[k] = Platform(url: url, signature: sig)
      }
    }
    return UpdateManifest(
      version: ver, notes: obj["notes"] as? String, date: obj["pub_date"] as? String, platforms: platforms)
  }
}

/// Pengaturan pembaruan dan endpoint per kanal.
public struct UpdaterSettings: Equatable, Sendable {
  public static let stable = "stable"
  public static let beta = "beta"
  public static let endpointStable = "https://github.com/jejak-dev/jejak/releases/latest/download/latest.json"
  public static let endpointBeta = "https://github.com/jejak-dev/jejak/releases/download/beta/latest.json"

  public var autoCheck: Bool
  public var channel: String

  public init(autoCheck: Bool = true, channel: String) {
    self.autoCheck = autoCheck
    self.channel = channel
  }

  /// Versi pra-rilis memakai kanal beta, rilis penuh kanal stabil.
  public static func defaultChannel(forVersion v: String) -> String {
    v.contains("-") ? beta : stable
  }

  public static func isValid(channel: String) -> Bool { channel == stable || channel == beta }

  public static func endpoint(forChannel c: String) -> String? {
    switch c {
    case stable: endpointStable
    case beta: endpointBeta
    default: nil
    }
  }
}
