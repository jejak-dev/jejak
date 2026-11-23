import AppKit
#if canImport(JejakShellCore)
import JejakShellCore
#endif

/// Menghubungkan pembaru inti dengan aplikasi: pengaturan, jadwal otomatis,
/// dan mulai ulang. Hanya aktif bila berjalan dari bundel `.app`.
@MainActor
final class UpdateController {
  private static let jedaAwal: UInt64 = 15 * 1_000_000_000
  private static let interval: UInt64 = 6 * 3600 * 1_000_000_000

  private let updater: Updater?
  private let versi: String
  private let defaults = UserDefaults.standard
  private var tugasOtomatis: Task<Void, Never>?
  /// Dipanggil saat pengguna meminta mulai ulang; AppDelegate yang keluar.
  var onRestart: ((URL) -> Void)?

  init() {
    versi = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    defaults.register(defaults: ["updater.autoCheck": true])
    let env = ProcessInfo.processInfo.environment
    // Override endpoint/kunci hanya untuk debug (sama seperti build debug Tauri).
    let debug = env["JEJAK_DEBUG"] == "1"
    let bundel = Bundle.main.bundleURL
    let kunci = (debug ? env["JEJAK_UPDATE_PUBKEY"] : nil)
      ?? (Bundle.main.object(forInfoDictionaryKey: "JejakUpdatePubKey") as? String)
    guard bundel.pathExtension == "app", let kunci, let sekarang = Semver(versi) else {
      updater = nil
      return
    }
    let timpa = debug ? env["JEJAK_UPDATE_ENDPOINT"].flatMap { $0.isEmpty ? nil : $0 } : nil
    updater = Updater(config: Updater.Config(
      currentVersion: sekarang, bundleURL: bundel, pubkey: kunci,
      endpoint: { kanal in
        if let timpa { return URL(string: timpa) }
        return UpdaterSettings.endpoint(forChannel: kanal).flatMap(URL.init(string:))
      },
      allowInsecure: timpa != nil))
  }

  // MARK: - Pengaturan

  var settings: UpdaterSettings {
    let kanal = defaults.string(forKey: "updater.channel") ?? UpdaterSettings.defaultChannel(forVersion: versi)
    return UpdaterSettings(
      autoCheck: defaults.bool(forKey: "updater.autoCheck"),
      channel: UpdaterSettings.isValid(channel: kanal) ? kanal : UpdaterSettings.defaultChannel(forVersion: versi))
  }

  var settingsJSON: [String: Any] { ["autoCheck": settings.autoCheck, "channel": settings.channel] }

  func apply(settings baru: UpdaterSettings) throws {
    guard UpdaterSettings.isValid(channel: baru.channel) else {
      throw UpdateControllerError(description: L("update.bad_channel", "kanal pembaruan tak dikenal"))
    }
    let lama = settings.channel
    defaults.set(baru.autoCheck, forKey: "updater.autoCheck")
    defaults.set(baru.channel, forKey: "updater.channel")
    if lama != baru.channel { updater?.discardPending() }
  }

  // MARK: - Perintah

  var statusJSON: [String: Any] { updater?.status.json ?? UpdateStatus().json }

  func check() async -> [String: Any] {
    guard let updater else { return UpdateStatus().json }
    return await updater.check(channel: settings.channel).json
  }

  func install() throws -> [String: Any] {
    guard let updater else {
      throw UpdateControllerError(description: L("update.unavailable", "pembaruan hanya tersedia pada aplikasi terpasang (.app)"))
    }
    return try updater.install().json
  }

  func restart() throws {
    guard let updater, updater.isReady else {
      throw UpdateControllerError(description: L("update.not_ready", "belum ada pembaruan siap dijalankan"))
    }
    onRestart?(Bundle.main.bundleURL)
  }

  // MARK: - Uji mandiri (debug)

  /// Hanya dengan JEJAK_DEBUG=1 dan JEJAK_UPDATE_SELFTEST=1: menjalankan alur
  /// periksa → unduh → pasang → mulai ulang tanpa klik, melapor ke stderr.
  /// Dipakai untuk verifikasi ujung ke ujung; tak aktif di pemakaian biasa.
  func startSelfTestIfRequested() {
    let env = ProcessInfo.processInfo.environment
    guard env["JEJAK_DEBUG"] == "1", env["JEJAK_UPDATE_SELFTEST"] == "1", updater != nil else { return }
    func lapor(_ s: String) { FileHandle.standardError.write(Data("[selftest] \(s)\n".utf8)) }
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 3 * 1_000_000_000)
      guard let self else { return }
      let a = await self.check()
      lapor("periksa -> \(a["state"] ?? "?") versi=\(a["version"] ?? "-") galat=\(a["error"] ?? "-")")
      guard (a["state"] as? String) == "available" else { return }
      do { _ = try self.install() } catch { lapor("install gagal: \(error)"); return }
      var s = self.statusJSON
      var terakhir = ""
      for _ in 0..<1200 {
        s = self.statusJSON
        let st = s["state"] as? String ?? "?"
        if st != terakhir { lapor("status -> \(st) \(s["downloaded"] ?? 0)/\(s["total"] ?? "?")"); terakhir = st }
        if st == "ready" || st == "error" { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      lapor("akhir: \(s["state"] ?? "?") galat=\(s["error"] ?? "-")")
      if (s["state"] as? String) == "ready" {
        lapor("mulai ulang")
        try? self.restart()
      }
    }
  }

  // MARK: - Jadwal otomatis

  /// Sekali setelah mulai (15 dtk), lalu tiap enam jam; menghormati `autoCheck`.
  func startAutoCheck() {
    guard updater != nil, tugasOtomatis == nil else { return }
    tugasOtomatis = Task { [weak self] in
      try? await Task.sleep(nanoseconds: Self.jedaAwal)
      while !Task.isCancelled {
        if let self, self.settings.autoCheck { _ = await self.check() }
        try? await Task.sleep(nanoseconds: Self.interval)
      }
    }
  }
}

struct UpdateControllerError: Error, CustomStringConvertible { let description: String }
