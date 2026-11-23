import CryptoKit
import Foundation
@testable import JejakShellCore

/// Penandatangan uji: menghasilkan format minisign varian ED seperti `tauri signer`.
struct TestSigner {
  let priv = Curve25519.Signing.PrivateKey()
  let keyID = Data((0..<8).map { _ in UInt8.random(in: 0...255) })

  var pubkeyBase64: String {
    let mentah = Data([0x45, 0x64]) + keyID + priv.publicKey.rawRepresentation
    let teks = "untrusted comment: minisign public key: TEST\n\(mentah.base64EncodedString())\n"
    return Data(teks.utf8).base64EncodedString()
  }

  func sign(_ file: URL) throws -> String {
    let digest = Blake2b.hash(try Data(contentsOf: file))
    let sig = try priv.signature(for: digest)
    let komentar = "timestamp:1\tfile:\(file.lastPathComponent)"
    let global = try priv.signature(for: sig + Data(komentar.utf8))
    let mentah = Data([0x45, 0x44]) + keyID + sig
    let teks = """
      untrusted comment: signature from test key
      \(mentah.base64EncodedString())
      trusted comment: \(komentar)
      \(global.base64EncodedString())

      """
    return Data(teks.utf8).base64EncodedString()
  }
}

/// Lingkungan uji: bundel lama terpasang, arsip baru bertanda tangan, manifest lokal.
struct UpdateRig {
  let root: URL
  let installed: URL
  let signer = TestSigner()
  let manifestURL: URL

  static func buatApp(di folder: URL, versi: String, id: String = "io.github.jejak-dev.jejak.native") throws -> URL {
    let app = folder.appendingPathComponent("Jejak.app")
    try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let info: NSDictionary = ["CFBundleIdentifier": id, "CFBundleShortVersionString": versi]
    guard info.write(to: app.appendingPathComponent("Contents/Info.plist"), atomically: true) else {
      throw GalatUji(description: "tak bisa menulis plist")
    }
    return app
  }

  init(
    lama: String = "0.1.0-beta.1", baru: String = "0.1.0-beta.2", manifest: String = "0.1.0-beta.2",
    idBaru: String = "io.github.jejak-dev.jejak.native", platformKey: String = "darwin-aarch64-native",
    penandaLain: TestSigner? = nil
  ) throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent("upd-\(UUID().uuidString)")
    let pasang = root.appendingPathComponent("Install")
    let sumber = root.appendingPathComponent("Source")
    for d in [pasang, sumber] { try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    installed = try Self.buatApp(di: pasang, versi: lama)
    _ = try Self.buatApp(di: sumber, versi: baru, id: idBaru)
    let arsip = root.appendingPathComponent("Jejak.app.tar.gz")
    let r = try Archive.run("/usr/bin/tar", ["-czf", arsip.path, "-C", sumber.path, "Jejak.app"])
    guard r.status == 0 else { throw GalatUji(description: "tar gagal: \(r.keluaran)") }
    let sig = try (penandaLain ?? signer).sign(arsip)
    let json: [String: Any] = [
      "version": manifest, "notes": "Catatan uji", "pub_date": "2026-11-23T00:00:00Z",
      "platforms": [platformKey: ["url": arsip.absoluteString, "signature": sig]],
    ]
    manifestURL = root.appendingPathComponent("latest.json")
    try JSONSerialization.data(withJSONObject: json).write(to: manifestURL)
  }

  func updater(versiSekarang: String = "0.1.0-beta.1") -> Updater {
    let url = manifestURL
    return Updater(config: Updater.Config(
      currentVersion: Semver(versiSekarang)!, bundleURL: installed, pubkey: signer.pubkeyBase64,
      platformKey: "darwin-aarch64-native", endpoint: { _ in url }, allowInsecure: true, verifyCodesign: false))
  }

  func versiTerpasang() -> String? {
    (NSDictionary(contentsOf: installed.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String
  }

  func sisaSementara() -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: installed.deletingLastPathComponent().path)) ?? []).filter { $0.hasPrefix(".jejak-update") }
  }

  func bersihkan() { try? FileManager.default.removeItem(at: root) }
}

/// Menunggu status akhir (ready/error) paling lama 30 dtk.
func tungguAkhir(_ u: Updater) async -> UpdateStatus {
  for _ in 0..<600 {
    let s = u.status
    if s.state == .ready || s.state == .error { return s }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return u.status
}

struct UpdaterTests {
  func periksaMenemukanVersiBaru() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    let s = await rig.updater().check(channel: "beta")
    expect(s.state == .available)
    expect(s.version == "0.1.0-beta.2")
    expect(s.notes == "Catatan uji")
    expect(s.lastCheck != nil)
  }

  func versiSamaAtauLebihBaruTakDitawarkan() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    let sama = await rig.updater(versiSekarang: "0.1.0-beta.2").check(channel: "beta")
    expect(sama.state == .idle)
    let lebihBaru = await rig.updater(versiSekarang: "0.1.0").check(channel: "beta")
    expect(lebihBaru.state == .idle)
  }

  func tanpaArtefakNativeDiabaikan() async throws {
    // Manifest hanya berisi kunci Tauri: cangkang native tak boleh memasangnya.
    let rig = try UpdateRig(platformKey: "darwin-aarch64-app"); defer { rig.bersihkan() }
    let s = await rig.updater().check(channel: "beta")
    expect(s.state == .idle)
  }

  func pasangPenuhMenggantiBundel() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    let u = rig.updater()
    _ = await u.check(channel: "beta")
    let mulai = try u.install()
    expect(mulai.state == .downloading)
    let akhir = await tungguAkhir(u)
    expect(akhir.state == .ready)
    expect(akhir.error == nil)
    expect(rig.versiTerpasang() == "0.1.0-beta.2")
    expect(rig.sisaSementara().isEmpty)
    expect(u.isReady)
  }

  func tandaTanganSalahDitolakDanBundelUtuh() async throws {
    let rig = try UpdateRig(penandaLain: TestSigner()); defer { rig.bersihkan() }
    let u = rig.updater()
    _ = await u.check(channel: "beta")
    try u.install()
    let akhir = await tungguAkhir(u)
    expect(akhir.state == .error)
    expect(akhir.error?.contains("kunci lain") == true)
    expect(rig.versiTerpasang() == "0.1.0-beta.1")
    expect(rig.sisaSementara().isEmpty)
  }

  func aplikasiLainDitolak() async throws {
    let rig = try UpdateRig(idBaru: "com.contoh.lain"); defer { rig.bersihkan() }
    let u = rig.updater()
    _ = await u.check(channel: "beta")
    try u.install()
    let akhir = await tungguAkhir(u)
    expect(akhir.state == .error)
    expect(rig.versiTerpasang() == "0.1.0-beta.1")
  }

  func versiArsipTakSesuaiManifestDitolak() async throws {
    let rig = try UpdateRig(baru: "0.1.0-beta.9"); defer { rig.bersihkan() }
    let u = rig.updater()
    _ = await u.check(channel: "beta")
    try u.install()
    let akhir = await tungguAkhir(u)
    expect(akhir.state == .error)
    expect(rig.versiTerpasang() == "0.1.0-beta.1")
  }

  func pasangTanpaPemeriksaanDitolak() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    expectThrows { try rig.updater().install() }
  }

  func httpTanpaOverrideDitolak() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    let url = rig.manifestURL
    let u = Updater(config: Updater.Config(
      currentVersion: Semver("0.1.0-beta.1")!, bundleURL: rig.installed, pubkey: rig.signer.pubkeyBase64,
      endpoint: { _ in url }, allowInsecure: false, verifyCodesign: false))
    let s = await u.check(channel: "beta")
    expect(s.state == .error)
    expect(s.error?.contains("https") == true)
  }

  func kanalTakDikenal() async throws {
    let rig = try UpdateRig(); defer { rig.bersihkan() }
    let u = Updater(config: Updater.Config(
      currentVersion: Semver("0.1.0-beta.1")!, bundleURL: rig.installed, pubkey: rig.signer.pubkeyBase64,
      endpoint: { UpdaterSettings.endpoint(forChannel: $0).flatMap(URL.init) }, allowInsecure: true, verifyCodesign: false))
    let s = await u.check(channel: "nightly")
    expect(s.state == .error)
  }

  func arsipTakAmanDitolak() {
    expect(Archive.isSafe(entries: ["Jejak.app/", "Jejak.app/Contents/Info.plist"]) == "Jejak.app")
    expect(Archive.isSafe(entries: ["../evil.app/x"]) == nil)
    expect(Archive.isSafe(entries: ["/abs/Jejak.app/x"]) == nil)
    expect(Archive.isSafe(entries: ["Jejak.app/../../x"]) == nil)
    expect(Archive.isSafe(entries: ["Jejak.app/a", "Lain.app/b"]) == nil)
    expect(Archive.isSafe(entries: ["skrip.sh"]) == nil)
  }

  func argumenMulaiUlang() {
    let a = Updater.relaunchArguments(pid: 123, bundle: URL(fileURLWithPath: "/Applications/Jejak.app"))
    expect(a.first == "-c" && a.suffix(2) == ["123", "/Applications/Jejak.app"])
    expect(a[1].contains("kill -0") && a[1].contains("open -n"))
  }
}

struct PengaturanPembaruTests {
  func kanalBawaan() {
    expect(UpdaterSettings.defaultChannel(forVersion: "0.1.0-beta.19") == "beta")
    expect(UpdaterSettings.defaultChannel(forVersion: "1.0.0") == "stable")
    expect(UpdaterSettings.isValid(channel: "beta") && UpdaterSettings.isValid(channel: "stable"))
    expect(!UpdaterSettings.isValid(channel: "nightly"))
    expect(UpdaterSettings.endpoint(forChannel: "nightly") == nil)
  }
  func transisiStatus() {
    var s = UpdateStatus()
    expect(!s.apply(.startDownload))                       // tak boleh dari idle
    expect(s.apply(.startCheck(at: 1)))
    expect(!s.apply(.startCheck(at: 2)))                   // tak ada pemeriksaan ganda
    expect(s.apply(.finishCheck(at: 3, version: "1.0.0", notes: "n", date: nil)))
    expect(s.state == .available && s.version == "1.0.0")
    expect(s.apply(.startDownload))
    expect(s.apply(.progress(downloaded: 5, total: 10)))
    expect(s.downloaded == 5 && s.total == 10)
    expect(s.apply(.finishDownload) && s.state == .installing)
    expect(s.apply(.finishInstall) && s.state == .ready)
    expect(s.apply(.fail(at: 9, message: "x")) && s.state == .error && s.error == "x")
    expect(s.apply(.startCheck(at: 10)))                   // setelah galat boleh periksa lagi
    expect((s.json["state"] as? String) == "checking")
  }
  func manifestRusak() {
    expectThrows { try UpdateManifest.parse(Data("bukan json".utf8)) }
    expectThrows { try UpdateManifest.parse(Data(#"{"version":"x"}"#.utf8)) }
  }
}
