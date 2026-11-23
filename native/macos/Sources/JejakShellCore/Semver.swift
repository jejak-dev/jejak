import Foundation

/// Versi semver sederhana dengan pra-rilis (mis. `0.1.0-beta.19`).
public struct Semver: Comparable, Equatable, CustomStringConvertible, Sendable {
  public let major: Int, minor: Int, patch: Int
  public let pre: [String]

  public init?(_ teks: String) {
    var s = teks.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("v") { s.removeFirst() }
    if let plus = s.firstIndex(of: "+") { s = String(s[..<plus]) }  // metadata build diabaikan
    var pra: [String] = []
    if let dash = s.firstIndex(of: "-") {
      pra = s[s.index(after: dash)...].split(separator: ".", omittingEmptySubsequences: false).map(String.init)
      s = String(s[..<dash])
      if pra.contains(where: \.isEmpty) { return nil }
    }
    let bagian = s.split(separator: ".", omittingEmptySubsequences: false)
    guard bagian.count == 3, let a = Int(bagian[0]), let b = Int(bagian[1]), let c = Int(bagian[2]),
      a >= 0, b >= 0, c >= 0
    else { return nil }
    major = a; minor = b; patch = c; pre = pra
  }

  public var isPrerelease: Bool { !pre.isEmpty }

  public var description: String {
    "\(major).\(minor).\(patch)" + (pre.isEmpty ? "" : "-" + pre.joined(separator: "."))
  }

  public static func < (a: Semver, b: Semver) -> Bool {
    if (a.major, a.minor, a.patch) != (b.major, b.minor, b.patch) {
      return (a.major, a.minor, a.patch) < (b.major, b.minor, b.patch)
    }
    // Rilis penuh lebih baru daripada pra-rilis dengan angka sama.
    if a.pre.isEmpty != b.pre.isEmpty { return !a.pre.isEmpty }
    for (x, y) in zip(a.pre, b.pre) where x != y {
      switch (Int(x), Int(y)) {
      case let (i?, j?): return i < j
      case (_?, nil): return true  // angka < teks
      case (nil, _?): return false
      default: return x < y
      }
    }
    return a.pre.count < b.pre.count
  }
}
