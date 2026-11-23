import Foundation

/// Pembaru otomatis cangkang native: periksa manifest, unduh, verifikasi
/// minisign, ekstrak, validasi, lalu ganti `.app` yang sedang berjalan.
///
/// Sengaja tak memakai kerangka pembaru pihak ketiga: kunci dan manifest sama
/// dengan pipeline Tauri (`tauri signer`), tetapi artefaknya khusus native.
public final class Updater: @unchecked Sendable {
  public struct Config: Sendable {
    public var currentVersion: Semver
    public var bundleURL: URL
    public var pubkey: String
    public var platformKey: String
    public var expectedBundleID: String
    /// Mengubah kanal menjadi URL manifest; nil = kanal tak dikenal.
    public var endpoint: @Sendable (String) -> URL?
    /// Izinkan skema non-https (hanya untuk override debug dan tes).
    public var allowInsecure: Bool
    public var verifyCodesign: Bool
    public var session: URLSession

    public init(
      currentVersion: Semver, bundleURL: URL, pubkey: String,
      platformKey: String = UpdateManifest.nativePlatformKey(),
      expectedBundleID: String = "io.github.jejak-dev.jejak.native",
      endpoint: @escaping @Sendable (String) -> URL?, allowInsecure: Bool = false,
      verifyCodesign: Bool = true, session: URLSession = .shared
    ) {
      self.currentVersion = currentVersion; self.bundleURL = bundleURL; self.pubkey = pubkey
      self.platformKey = platformKey; self.expectedBundleID = expectedBundleID
      self.endpoint = endpoint; self.allowInsecure = allowInsecure
      self.verifyCodesign = verifyCodesign; self.session = session
    }
  }

  private let config: Config
  private let lock = NSLock()
  private var _status = UpdateStatus()
  private var pending: (manifest: UpdateManifest, platform: UpdateManifest.Platform)?
  private var busy = false

  public init(config: Config) { self.config = config }

  public var status: UpdateStatus {
    lock.lock(); defer { lock.unlock() }
    return _status
  }

  private func mutate(_ e: UpdateEvent) {
    lock.lock(); _status.apply(e); lock.unlock()
  }

  private func now() -> UInt64 { UInt64(Date().timeIntervalSince1970) }

  // MARK: - Periksa

  /// Memeriksa manifest kanal; hanya satu pemeriksaan pada satu waktu.
  @discardableResult
  public func check(channel: String) async -> UpdateStatus {
    if let langsung = mulaiPeriksa() { return langsung }
    defer { setBusy(false) }

    do {
      let hasil = try await ambilManifest(channel: channel)
      simpanTertahan(hasil)
      mutate(.finishCheck(at: now(), version: hasil?.0.version.description, notes: hasil?.0.notes, date: hasil?.0.date))
    } catch {
      mutate(.fail(at: now(), message: "\(error)"))
    }
    return status
  }

  /// nil = pemeriksaan dimulai; selain itu status yang dikembalikan apa adanya.
  private func mulaiPeriksa() -> UpdateStatus? {
    lock.withLock {
      if busy { return _status }
      guard _status.apply(.startCheck(at: now())) else { return _status }
      busy = true
      return nil
    }
  }
  private func setBusy(_ nilai: Bool) { lock.withLock { busy = nilai } }
  private func simpanTertahan(_ h: (UpdateManifest, UpdateManifest.Platform)?) {
    lock.withLock { pending = h.map { ($0.0, $0.1) } }
  }

  private func ambilManifest(channel: String) async throws -> (UpdateManifest, UpdateManifest.Platform)? {
    guard let url = config.endpoint(channel) else {
      throw MinisignError(description: L("update.bad_channel", "kanal pembaruan tak dikenal"))
    }
    try cekSkema(url)
    let (data, resp) = try await config.session.data(from: url)
    if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
      if http.statusCode == 404 && channel == UpdaterSettings.stable {
        throw MinisignError(description: L("update.no_stable", "Belum ada rilis stabil. Pilih kanal Beta di Pengaturan."))
      }
      throw MinisignError(description: L("update.http", "server pembaruan menjawab %@", "\(http.statusCode)"))
    }
    let manifest = try UpdateManifest.parse(data)
    guard manifest.version > config.currentVersion, let platform = manifest.platforms[config.platformKey] else {
      return nil  // terbaru, atau belum ada artefak native untuk platform ini
    }
    return (manifest, platform)
  }

  private func cekSkema(_ url: URL) throws {
    if config.allowInsecure { return }
    guard url.scheme == "https" else {
      throw MinisignError(description: L("update.insecure", "alamat pembaruan harus https"))
    }
  }

  /// Membuang pembaruan yang tertahan (mis. saat kanal berganti).
  public func discardPending() {
    lock.withLock {
      pending = nil
      _status.apply(.dropPending)
    }
  }

  // MARK: - Pasang

  /// Memulai unduh+pasang di latar belakang; status dipantau lewat `status`.
  @discardableResult
  public func install() throws -> UpdateStatus {
    lock.lock()
    guard !busy else {
      lock.unlock()
      throw MinisignError(description: L("update.busy", "pemasangan pembaruan sedang berjalan"))
    }
    guard let tertahan = pending, _status.apply(.startDownload) else {
      lock.unlock()
      throw MinisignError(description: L("update.none", "belum ada pembaruan untuk dipasang"))
    }
    pending = nil
    busy = true
    let s = _status
    lock.unlock()
    Task.detached { [self] in
      do {
        try await pasang(tertahan.manifest, tertahan.platform)
        mutate(.finishInstall)
      } catch {
        mutate(.fail(at: now(), message: "\(error)"))
      }
      setBusy(false)
    }
    return s
  }

  private func pasang(_ manifest: UpdateManifest, _ platform: UpdateManifest.Platform) async throws {
    try cekSkema(platform.url)
    let kerja = FileManager.default.temporaryDirectory.appendingPathComponent("jejak-update-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: kerja, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: kerja) }

    let arsip = kerja.appendingPathComponent("update.tar.gz")
    try await Downloader.download(platform.url, to: arsip, session: config.session) { [self] got, total in
      mutate(.progress(downloaded: got, total: total))
    }
    mutate(.finishDownload)

    // Verifikasi SEBELUM menyentuh isi arsip.
    try MinisignPublicKey(base64Tauri: config.pubkey).verify(file: arsip, signatureBase64: platform.signature)

    let hasil = kerja.appendingPathComponent("x")
    try FileManager.default.createDirectory(at: hasil, withIntermediateDirectories: true)
    let baru = try Archive.extractApp(arsip, into: hasil)

    try validasi(baru, versi: manifest.version)
    try Self.ganti(config.bundleURL, dengan: baru)
  }

  private func validasi(_ app: URL, versi: Semver) throws {
    let plist = app.appendingPathComponent("Contents/Info.plist")
    guard let info = NSDictionary(contentsOf: plist) as? [String: Any] else {
      throw MinisignError(description: L("update.bad_app", "aplikasi pembaruan tak sah"))
    }
    guard info["CFBundleIdentifier"] as? String == config.expectedBundleID else {
      throw MinisignError(description: L("update.wrong_app", "arsip pembaruan bukan aplikasi Jejak native"))
    }
    guard let v = (info["CFBundleShortVersionString"] as? String).flatMap(Semver.init), v == versi else {
      throw MinisignError(description: L("update.version_mismatch", "versi aplikasi di arsip tak sesuai manifest"))
    }
    if config.verifyCodesign {
      let r = try Archive.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
      guard r.status == 0 else {
        throw MinisignError(description: L("update.codesign", "tanda tangan kode aplikasi pembaruan tak valid"))
      }
    }
  }

  /// Mengganti bundel target secara atomik (swap), tanpa meninggalkan sisa.
  static func ganti(_ target: URL, dengan baru: URL) throws {
    let fm = FileManager.default
    let induk = target.deletingLastPathComponent()
    guard fm.isWritableFile(atPath: induk.path) else {
      throw MinisignError(description: L("update.not_writable", "folder aplikasi tak bisa ditulis: %@", induk.path))
    }
    // Pindahkan dulu ke volume yang sama dengan target agar penggantian atomik.
    let sementara = induk.appendingPathComponent(".jejak-update-\(UUID().uuidString).app")
    try fm.copyItem(at: baru, to: sementara)
    do {
      _ = try fm.replaceItemAt(target, withItemAt: sementara, backupItemName: nil, options: [])
    } catch {
      try? fm.removeItem(at: sementara)
      throw error
    }
  }

  // MARK: - Mulai ulang

  /// Perintah shell yang menunggu proses ini keluar lalu membuka bundel baru.
  public static func relaunchArguments(pid: Int32, bundle: URL) -> [String] {
    ["-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; /usr/bin/open -n \"$2\"", "sh", "\(pid)", bundle.path]
  }

  /// Sah bila pembaruan sudah terpasang dan siap dijalankan.
  public var isReady: Bool { status.state == .ready }
}
