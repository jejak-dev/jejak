import Darwin
import Foundation

/// Pengelola proses sidecar `jejak serve --desktop`.
///
/// Proses dijalankan di process group sendiri supaya `stop()` ikut mematikan
/// anak-anaknya (shell terminal, agent). Stdin dibiarkan terbuka: menutupnya
/// adalah sinyal berhenti yang sopan bagi server. Token tidak pernah dicetak.
public final class SidecarProcess: @unchecked Sendable {
  public static let readyTimeout: TimeInterval = 30
  public static let exitGrace: TimeInterval = 3

  private let lock = NSLock()
  private var pid: pid_t = 0
  private var stdinFD: Int32 = -1
  private var stopped = false
  private var readyInfo: ReadyInfo?
  private var failure: String?
  private var exited = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var exitHandler: (@Sendable (Int32) -> Void)?

  /// 200 baris stderr terakhir.
  public let stderr = LineRingBuffer(capacity: 200)

  public init() {}

  /// Dipanggil sekali bila proses berhenti SETELAH siap dan bukan karena `stop()`.
  public func onUnexpectedExit(_ handler: @escaping @Sendable (Int32) -> Void) {
    lock.lock()
    exitHandler = handler
    lock.unlock()
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return pid != 0 && !exited
  }

  /// Menjalankan sidecar. Token dikirim lewat lingkungan proses anak saja.
  public func start(binary: URL, token: String, extraEnv: [String: String] = [:]) throws {
    var env = ProcessInfo.processInfo.environment
    for (k, v) in extraEnv { env[k] = v }
    env["JEJAK_DESKTOP_TOKEN"] = token
    env["PORT"] = "0"

    var stdinPipe: [Int32] = [0, 0]
    var stdoutPipe: [Int32] = [0, 0]
    var stderrPipe: [Int32] = [0, 0]
    guard pipe(&stdinPipe) == 0, pipe(&stdoutPipe) == 0, pipe(&stderrPipe) == 0 else {
      throw ReadyLineError(description: "gagal membuat pipa: \(String(cString: strerror(errno)))")
    }

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_adddup2(&actions, stdinPipe[0], 0)
    posix_spawn_file_actions_adddup2(&actions, stdoutPipe[1], 1)
    posix_spawn_file_actions_adddup2(&actions, stderrPipe[1], 2)
    for fd in stdinPipe + stdoutPipe + stderrPipe {
      posix_spawn_file_actions_addclose(&actions, fd)
    }

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    // Grup baru dengan anak sebagai pemimpin: pgid == pid.
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attr, 0)

    let argv = [binary.path, "serve", "--desktop"]
    let envp = env.map { "\($0.key)=\($0.value)" }
    var cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
    var cEnv: [UnsafeMutablePointer<CChar>?] = envp.map { strdup($0) } + [nil]
    defer {
      for p in cArgs { free(p) }
      for p in cEnv { free(p) }
    }

    var anakVar: pid_t = 0
    let hasil = posix_spawn(&anakVar, binary.path, &actions, &attr, &cArgs, &cEnv)
    let anak = anakVar
    // Sisi anak sudah diwariskan; tutup di sisi kita.
    close(stdinPipe[0]); close(stdoutPipe[1]); close(stderrPipe[1])
    guard hasil == 0 else {
      close(stdinPipe[1]); close(stdoutPipe[0]); close(stderrPipe[0])
      throw ReadyLineError(
        description: "gagal menjalankan sidecar \(binary.path): \(String(cString: strerror(hasil)))")
    }

    lock.lock()
    pid = anak
    stdinFD = stdinPipe[1]
    lock.unlock()

    let outFD = stdoutPipe[0]
    let errFD = stderrPipe[0]
    Thread.detachNewThread { [self] in bacaStdout(outFD) }
    Thread.detachNewThread { [self] in bacaStderr(errFD) }
    Thread.detachNewThread { [self] in tungguKeluar(anak) }
  }

  // MARK: - Pembaca

  private func bacaBaris(_ fd: Int32, _ tiapBaris: (String) -> Void) {
    var sisa = Data()
    var buf = [UInt8](repeating: 0, count: 8192)
    while true {
      let n = read(fd, &buf, buf.count)
      if n < 0 && errno == EINTR { continue }
      if n <= 0 { break }
      sisa.append(buf, count: n)
      while let idx = sisa.firstIndex(of: 0x0A) {
        let baris = String(decoding: sisa[sisa.startIndex..<idx], as: UTF8.self)
        sisa.removeSubrange(sisa.startIndex...idx)
        tiapBaris(baris)
      }
    }
    if !sisa.isEmpty { tiapBaris(String(decoding: sisa, as: UTF8.self)) }
    close(fd)
  }

  private func bacaStdout(_ fd: Int32) {
    bacaBaris(fd) { [self] baris in
      lock.lock()
      let sudah = readyInfo != nil || failure != nil
      lock.unlock()
      if sudah { return }  // terus kuras pipa, abaikan isinya
      do {
        if let info = try ReadyLine.parse(baris) { selesaiSiap(info: info, galat: nil) }
      } catch {
        selesaiSiap(info: nil, galat: "\(error)")
      }
    }
  }

  private func bacaStderr(_ fd: Int32) {
    bacaBaris(fd) { [self] baris in stderr.append(baris) }
  }

  private func tungguKeluar(_ anak: pid_t) {
    var status: Int32 = 0
    while waitpid(anak, &status, 0) < 0 && errno == EINTR {}
    let kode: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
    lock.lock()
    exited = true
    let sengaja = stopped
    let sudahSiap = readyInfo != nil
    let handler = exitHandler
    if readyInfo == nil && failure == nil {
      failure = "Server Jejak berhenti sebelum siap"
    }
    let pending = waiters
    waiters = []
    lock.unlock()
    for w in pending { w.resume() }
    if sudahSiap && !sengaja { handler?(kode) }
  }

  private func selesaiSiap(info: ReadyInfo?, galat: String?) {
    lock.lock()
    if readyInfo == nil && failure == nil {
      readyInfo = info
      failure = galat
    }
    let pending = waiters
    waiters = []
    lock.unlock()
    for w in pending { w.resume() }
  }

  // MARK: - Menunggu siap

  /// Menunggu baris `JEJAK_READY`. Galat memuat ringkasan stderr.
  public func waitReady(timeout: TimeInterval = SidecarProcess.readyTimeout) async throws -> ReadyInfo {
    let batas = Task { [self] in
      try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
      selesaiSiap(info: nil, galat: "Server Jejak tak siap dalam \(Int(timeout)) detik")
    }
    defer { batas.cancel() }
    await withCheckedContinuation { (k: CheckedContinuation<Void, Never>) in
      lock.lock()
      if readyInfo != nil || failure != nil {
        lock.unlock()
        k.resume()
      } else {
        waiters.append(k)
        lock.unlock()
      }
    }
    let (info, galat) = hasilSiap()
    if let info { return info }
    let ringkas = stderr.summary()
    throw ReadyLineError(
      description: [galat ?? "Server Jejak tak bisa dimulai", ringkas]
        .filter { !$0.isEmpty }.joined(separator: "\n"))
  }

  private func hasilSiap() -> (ReadyInfo?, String?) {
    lock.lock()
    defer { lock.unlock() }
    return (readyInfo, failure)
  }

  // MARK: - Berhenti

  /// Menutup stdin, menunggu, lalu mematikan SELURUH grup proses. Idempoten.
  public func stop() {
    lock.lock()
    if stopped {
      lock.unlock()
      return
    }
    stopped = true
    let anak = pid
    let fd = stdinFD
    stdinFD = -1
    lock.unlock()
    guard anak != 0 else { return }
    if fd >= 0 { close(fd) }

    if !tunggu(sampai: Self.exitGrace) {
      killpg(anak, SIGTERM)
      if !tunggu(sampai: 2) { killpg(anak, SIGKILL) }
    }
    // Anak langsung sudah selesai; pastikan sisa grup (cucu) juga mati.
    killpg(anak, SIGTERM)
    _ = tunggu(sampai: 0.5)
    killpg(anak, SIGKILL)
  }

  private func tunggu(sampai detik: TimeInterval) -> Bool {
    let batas = Date().addingTimeInterval(detik)
    while Date() < batas {
      lock.lock()
      let selesai = exited
      lock.unlock()
      if selesai { return true }
      usleep(20_000)
    }
    lock.lock()
    defer { lock.unlock() }
    return exited
  }
}
