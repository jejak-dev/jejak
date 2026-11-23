import Foundation

@testable import JejakShellCore

struct ReadyLineTests {
  func barisSahDibaca() throws {
    let info = try require(
      try ReadyLine.parse(#"JEJAK_READY {"port":51234,"host":"127.0.0.1","version":"0.0.1"}"#))
    expect(info == ReadyInfo(port: 51234, host: "127.0.0.1", version: "0.0.1"))
  }
  func barisBiasaDiabaikan() throws {
    let a = try ReadyLine.parse("server mendengarkan"); expect(a == nil)
    let b = try ReadyLine.parse(#"JEJAK_READYX {"port":1}"#); expect(b == nil)
  }
  func tanpaPayloadGalat() {
    expectThrows { try ReadyLine.parse("JEJAK_READY") }
    expectThrows { try ReadyLine.parse("JEJAK_READY   ") }
  }
  func jsonRusakGalat() {
    expectThrows { try ReadyLine.parse("JEJAK_READY {rusak") }
    expectThrows { try ReadyLine.parse(#"JEJAK_READY {"host":"x"}"#) }
  }
  func portDiLuarRentangGalat() {
    expectThrows { try ReadyLine.parse(#"JEJAK_READY {"port":0}"#) }
    expectThrows { try ReadyLine.parse(#"JEJAK_READY {"port":70000}"#) }
    expectThrows { try ReadyLine.parse(#"JEJAK_READY {"port":true}"#) }
  }
  func bawaanHostDanVersi() throws {
    let info = try require(try ReadyLine.parse(#"JEJAK_READY {"port":8}"#))
    expect(info.host == "127.0.0.1" && info.version == "")
  }
}

struct TokenTests {
  func tokenDibuatSah() throws {
    let t = try DesktopToken.generate()
    expect(DesktopToken.isValid(t))
    expect(t.count == 43)
    let t2 = try DesktopToken.generate(); expect(t2 != t)
  }
  func tokenTakSah() {
    expect(!DesktopToken.isValid("pendek"))
    expect(!DesktopToken.isValid(String(repeating: "a", count: 31)))
    expect(!DesktopToken.isValid(String(repeating: "a", count: 31) + "+"))
    expect(DesktopToken.isValid(String(repeating: "a", count: 32)))
  }
}

struct NavigationTests {
  func enterURL() {
    expect(NavigationPolicy.enterURL(port: 5, token: "abc") == "http://127.0.0.1:5/__desktop/enter?t=abc")
  }
  func daftarPutih() {
    expect(NavigationPolicy.isAllowedNavigation("http://127.0.0.1:5000/x", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("http://127.0.0.1:5001/", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("http://localhost:5000/", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("https://127.0.0.1:5000/", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("https://example.com", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("file:///etc/passwd", port: 5000))
    expect(!NavigationPolicy.isAllowedNavigation("http://127.0.0.1:5000/", port: 0))
  }
  func tautanEksternal() {
    expect(NavigationPolicy.externalOpenTarget("https://example.com/a", port: 5000) == "https://example.com/a")
    expect(NavigationPolicy.externalOpenTarget("http://127.0.0.1:5000/a", port: 5000) == nil)
    expect(NavigationPolicy.externalOpenTarget("javascript:alert(1)", port: 5000) == nil)
    expect(NavigationPolicy.externalOpenTarget("file:///etc/hosts", port: 5000) == nil)
    expect(NavigationPolicy.externalOpenTarget("mailto:a@b.c", port: 5000) == nil)
  }
}

struct RingBufferTests {
  func menyimpan200Terakhir() {
    let b = LineRingBuffer(capacity: 200)
    for i in 0..<250 { b.append("baris \(i)") }
    expect(b.snapshot.count == 200)
    expect(b.snapshot.first == "baris 50")
    expect(b.snapshot.last == "baris 249")
  }
}

struct SidecarProcessTests {
  func skrip(_ isi: String) throws -> (URL, URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("jejak-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("jejak")
    try isi.write(to: url, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    return (dir, url)
  }

  func siapLaluStopMematikanGrup() async throws {
    let (dir, bin) = try skrip(
      """
      #!/bin/bash
      sleep 300 &
      echo $! > "$(dirname "$0")/anak.pid"
      echo 'JEJAK_READY {"port":1234,"host":"127.0.0.1","version":"0.0.0"}'
      cat >/dev/null
      wait
      """)
    defer { try? FileManager.default.removeItem(at: dir) }
    let p = SidecarProcess()
    try p.start(binary: bin, token: try DesktopToken.generate())
    let info = try await p.waitReady(timeout: 10)
    expect(info.port == 1234)
    let pidAnak = pid_t(
      try String(contentsOf: dir.appendingPathComponent("anak.pid"), encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines))!
    expect(kill(pidAnak, 0) == 0)
    p.stop()
    usleep(300_000)
    expect(!p.isRunning)
    expect(kill(pidAnak, 0) != 0)  // anak ikut mati lewat kill grup
    p.stop()  // idempoten
  }

  func berhentiSebelumSiapMembawaStderr() async throws {
    let (dir, bin) = try skrip("#!/bin/bash\necho 'rusak parah' >&2\nexit 3\n")
    defer { try? FileManager.default.removeItem(at: dir) }
    let p = SidecarProcess()
    try p.start(binary: bin, token: try DesktopToken.generate())
    do {
      _ = try await p.waitReady(timeout: 10)
      fail("seharusnya galat")
    } catch {
      expect("\(error)".contains("berhenti sebelum siap"))
      expect("\(error)".contains("rusak parah"))
    }
  }

  func timeout() async throws {
    let (dir, bin) = try skrip("#!/bin/bash\ncat >/dev/null\n")
    defer { try? FileManager.default.removeItem(at: dir) }
    let p = SidecarProcess()
    try p.start(binary: bin, token: try DesktopToken.generate())
    do {
      _ = try await p.waitReady(timeout: 1)
      fail("seharusnya timeout")
    } catch {
      expect("\(error)".contains("tak siap"))
    }
    p.stop()
  }

  func tokenTidakBocorKeStderr() async throws {
    let (dir, bin) = try skrip(
      "#!/bin/bash\n[ -n \"$JEJAK_DESKTOP_TOKEN\" ] && echo 'JEJAK_READY {\"port\":9}'\ncat >/dev/null\n")
    defer { try? FileManager.default.removeItem(at: dir) }
    let p = SidecarProcess()
    try p.start(binary: bin, token: try DesktopToken.generate())
    let i9 = try await p.waitReady(timeout: 10); expect(i9.port == 9)
    p.stop()
  }

  /// Opsional: sidecar asli. Lewati bila binary tak ada.
  func sidecarAsli() async throws {
    let bin = URL(fileURLWithPath: "../../src-tauri/binaries/jejak-aarch64-apple-darwin", relativeTo: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()).standardized
    guard FileManager.default.isExecutableFile(atPath: bin.path) else { return }
    let token = try DesktopToken.generate()
    let p = SidecarProcess()
    try p.start(binary: bin, token: token)
    let info = try await p.waitReady(timeout: 30)
    var req = URLRequest(url: URL(string: NavigationPolicy.enterURL(port: info.port, token: token))!)
    req.httpShouldHandleCookies = false
    final class Tanpa: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
      func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse,
        newRequest: URLRequest) async -> URLRequest? { nil }
    }
    let (_, resp) = try await URLSession(configuration: .ephemeral, delegate: Tanpa(), delegateQueue: nil).data(for: req)
    let http = try require(resp as? HTTPURLResponse)
    expect(http.statusCode == 302)
    expect(http.value(forHTTPHeaderField: "Set-Cookie") != nil)
    p.stop()
    expect(!p.isRunning)
  }
}

struct LokalisasiTests {
  func gantiArgumen() {
    expect(L("tak.ada", "a %@ b %@", "1", "2") == "a 1 b 2")
    expect(L("tak.ada", "100%", "x") == "100%")
    expect(L("tak.ada", "polos") == "polos")
    expect(L("tak.ada", "nilai %@", "50% lagi") == "nilai 50% lagi")
  }
}
