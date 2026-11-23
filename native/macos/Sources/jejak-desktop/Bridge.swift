import AppKit
import UserNotifications
import WebKit
#if canImport(JejakShellCore)
import JejakShellCore
#endif

/// Jembatan halaman → cangkang. Halaman Jejak memanggil
/// `window.__TAURI_INTERNALS__.invoke(cmd, args)` (kontrak lama Tauri); di sini
/// diterjemahkan ke perintah native tanpa mengubah klien web.
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
  var port: UInt16 = 0
  let updates: UpdateController

  init(updates: UpdateController) {
    self.updates = updates
    super.init()
  }

  private static let nama = "jejak"
  private static let skrip = """
  (function () {
    if (window.__TAURI_INTERNALS__) return;
    window.__TAURI_INTERNALS__ = {
      invoke: function (cmd, args) {
        return window.webkit.messageHandlers.\(nama).postMessage({ cmd: cmd, args: args === undefined ? null : args });
      }
    };
  })();
  """

  func pasang(di kontrol: WKUserContentController) {
    kontrol.addScriptMessageHandler(self, contentWorld: .page, name: Self.nama)
    kontrol.addUserScript(WKUserScript(source: Self.skrip, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    // Shim notifikasi lama (Notification API di atas jembatan ini).
    if let url = Bundle.main.url(forResource: "notification", withExtension: "js"),
       let js = try? String(contentsOf: url, encoding: .utf8) {
      kontrol.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage,
                             replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
    let o = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, o.protocol == "http", o.host == NavigationPolicy.loopback,
          o.port == Int(port), let isi = message.body as? [String: Any], let cmd = isi["cmd"] as? String
    else { return replyHandler(nil, L("bridge.rejected", "pesan jembatan ditolak: asal tak dikenal")) }
    let args = isi["args"] as? [String: Any]
    Task { @MainActor in
      do { replyHandler(try await self.tangani(cmd, args), nil) }
      catch { replyHandler(nil, "\(error)") }
    }
  }

  private struct Galat: Error, CustomStringConvertible { let description: String }

  private func tangani(_ cmd: String, _ args: [String: Any]?) async throws -> Any? {
    let d = UserDefaults.standard
    switch cmd {
    case "desktop_info":
      let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
      return ["version": v, "platform": "macos"]
    case "updater_get_settings":
      return updates.settingsJSON
    case "updater_set_settings":
      // Bentuk bersarang ({settings:{..}}) atau datar ({autoCheck, channel}).
      let b = args?["settings"] as? [String: Any] ?? args ?? [:]
      guard let auto = b["autoCheck"] as? Bool, let kanal = b["channel"] as? String else {
        throw Galat(description: L("update.incomplete", "pengaturan pembaruan tak lengkap"))
      }
      try updates.apply(settings: UpdaterSettings(autoCheck: auto, channel: kanal))
      return updates.settingsJSON
    case "updater_status":
      return updates.statusJSON
    case "updater_check":
      return await updates.check()
    case "updater_install":
      return try updates.install()
    case "updater_restart":
      try updates.restart()
      return NSNull()
    case "plugin:notification|is_permission_granted":
      guard Bundle.main.bundleIdentifier != nil else { return false }
      let s = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
      switch s {
      case .authorized, .provisional: return true
      case .denied: return false
      default: return NSNull()
      }
    case "plugin:notification|request_permission":
      guard Bundle.main.bundleIdentifier != nil else { return "denied" }
      let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
      return ok ? "granted" : "denied"
    case "plugin:notification|notify":
      guard Bundle.main.bundleIdentifier != nil else { throw Galat(description: L("bridge.notif_needs_app", "notifikasi butuh aplikasi terbungkus (.app)")) }
      let opsi = args?["options"] as? [String: Any] ?? [:]
      let isi = UNMutableNotificationContent()
      isi.title = opsi["title"] as? String ?? "Jejak"
      isi.body = opsi["body"] as? String ?? ""
      isi.sound = .default
      try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: isi, trigger: nil))
      return NSNull()
    default:
      throw Galat(description: L("bridge.unknown_command", "perintah tak dikenal: %@", cmd))
    }
  }
}
