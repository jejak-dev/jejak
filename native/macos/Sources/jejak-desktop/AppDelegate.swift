import AppKit
#if canImport(JejakShellCore)
import JejakShellCore
#endif

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow?
  private let updates = UpdateController()
  private lazy var content = ContentController(updates: updates)
  private var sidecar: SidecarProcess?
  private var sinyal: [DispatchSourceSignal] = []
  private var sedangKeluar = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    if fokuskanInstanceLain() { exit(0) }
    pasangMenu()
    buatJendela()
    content.onRetry = { [weak self] in self?.luncurkan() }
    pasangSinyal()
    NSApp.activate(ignoringOtherApps: true)
    updates.onRestart = { [weak self] bundel in self?.mulaiUlangUntukPembaruan(bundel) }
    updates.startAutoCheck()
    updates.startSelfTestIfRequested()
    luncurkan()
  }

  /// Menjadwalkan pembukaan bundel baru SETELAH proses ini keluar (instance
  /// tunggal akan menolak bila yang lama masih hidup), lalu keluar.
  private func mulaiUlangUntukPembaruan(_ bundel: URL) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = Updater.relaunchArguments(pid: ProcessInfo.processInfo.processIdentifier, bundle: bundel)
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return }
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  /// Menutup sidecar di luar main thread supaya UI tak membeku saat keluar.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let sidecar, !sedangKeluar else { return .terminateNow }
    sedangKeluar = true
    DispatchQueue.global().async {
      sidecar.stop()
      // Saat terminateLater AppKit menunggu di mode run loop modal; blok
      // `DispatchQueue.main.async` tak jalan di sana dan keluar akan macet.
      RunLoop.main.perform(inModes: [.common, .default, .modalPanel, .eventTracking]) {
        NSApp.reply(toApplicationShouldTerminate: true)
      }
      CFRunLoopWakeUp(CFRunLoopGetMain())
    }
    return .terminateLater
  }

  // MARK: - Instance tunggal

  /// Bila instance lain sudah berjalan, fokuskan dan kembalikan true.
  private func fokuskanInstanceLain() -> Bool {
    guard let id = Bundle.main.bundleIdentifier else { return false }
    let saya = ProcessInfo.processInfo.processIdentifier
    let lain = NSRunningApplication.runningApplications(withBundleIdentifier: id)
      .first { $0.processIdentifier != saya }
    guard let lain else { return false }
    lain.activate()
    return true
  }

  // MARK: - Jendela

  private func buatJendela() {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    w.title = "Jejak"
    w.minSize = NSSize(width: 900, height: 600)
    w.contentViewController = content
    w.isReleasedWhenClosed = false
    if !w.setFrameUsingName("JejakMain") { w.center() }
    w.setFrameAutosaveName("JejakMain")
    w.makeKeyAndOrderFront(nil)
    window = w
  }

  // MARK: - Sidecar

  private func luncurkan() {
    content.showSplash(L("splash.starting", "Memulai Jejak…"))
    let lama = sidecar
    let baru = SidecarProcess()
    sidecar = baru
    Task.detached { [weak self] in
      lama?.stop()
      do {
        let folder = Bundle.main.executableURL?.deletingLastPathComponent()
          ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        let biner = try BinaryLocator.locate(executableFolder: folder)
        let token = try DesktopToken.generate()
        try baru.start(binary: biner, token: token)
        let info = try await baru.waitReady()
        await MainActor.run { self?.siap(info: info, token: token, proses: baru) }
      } catch {
        let rincian = "\(error)"
        await MainActor.run { self?.gagal(L("error.start_failed", "Jejak tak bisa dimulai"), rincian) }
      }
    }
  }

  private func siap(info: ReadyInfo, token: String, proses: SidecarProcess) {
    guard proses === sidecar else { return }
    proses.onUnexpectedExit { [weak self] kode in
      let ringkas = proses.stderr.summary()
      Task { @MainActor in
        self?.gagal(L("error.server_exited", "Server Jejak berhenti tiba-tiba (kode %@)", "\(kode)"), ringkas)
      }
    }
    content.showWeb(port: info.port, enterURL: NavigationPolicy.enterURL(port: info.port, token: token))
  }

  private func gagal(_ judul: String, _ rincian: String) {
    content.showFailure(title: judul, detail: rincian)
  }

  // MARK: - Sinyal

  private func pasangSinyal() {
    for sig in [SIGTERM, SIGINT] {
      signal(sig, SIG_IGN)
      let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
      src.setEventHandler { NSApp.terminate(nil) }
      src.resume()
      sinyal.append(src)
    }
  }

  // MARK: - Aksi menu

  @objc func muatUlang(_ sender: Any?) { content.reload() }
  @objc func perbesar(_ sender: Any?) { content.zoom(by: 0.1) }
  @objc func perkecil(_ sender: Any?) { content.zoom(by: -0.1) }
  @objc func ukuranAsli(_ sender: Any?) { content.zoomReset() }
}
