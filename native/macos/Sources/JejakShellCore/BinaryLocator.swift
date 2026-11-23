import Foundation

/// Mencari binary sidecar `jejak`.
public enum BinaryLocator {
  public static let tripleDefault: String = {
    #if arch(arm64)
    "aarch64-apple-darwin"
    #else
    "x86_64-apple-darwin"
    #endif
  }()

  /// `env["JEJAK_SIDECAR"]` menang; lalu kandidat relatif ke folder executable.
  public static func locate(
    env: [String: String] = ProcessInfo.processInfo.environment,
    executableFolder: URL,
    triple: String = tripleDefault
  ) throws -> URL {
    let fm = FileManager.default
    if let nilai = env["JEJAK_SIDECAR"], !nilai.isEmpty {
      if fm.isExecutableFile(atPath: nilai) { return URL(fileURLWithPath: nilai) }
      throw ReadyLineError(description: "JEJAK_SIDECAR menunjuk berkas yang tak ada: \(nilai)")
    }
    let kandidat: [URL] = [
      executableFolder.appendingPathComponent("jejak"),
      executableFolder.appendingPathComponent("jejak-\(triple)"),
      executableFolder.appendingPathComponent("binaries/jejak"),
      executableFolder.appendingPathComponent("../Resources/binaries/jejak").standardized,
    ]
    for url in kandidat where fm.isExecutableFile(atPath: url.path) { return url }
    let dicoba = kandidat.map(\.path).joined(separator: ", ")
    throw ReadyLineError(description: "binary sidecar tak ditemukan. Dicoba: \(dicoba)")
  }
}
