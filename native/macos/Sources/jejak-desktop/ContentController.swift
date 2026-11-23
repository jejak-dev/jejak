import AppKit
import WebKit
#if canImport(JejakShellCore)
import JejakShellCore
#endif

/// Mengganti isi jendela: splash, layar galat, atau WKWebView.
@MainActor
final class ContentController: NSViewController {
  var onRetry: (() -> Void)?
  private var webView: WKWebView?
  private let bridge: Bridge
  let updates: UpdateController

  init(updates: UpdateController) {
    self.updates = updates
    self.bridge = Bridge(updates: updates)
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("tak dipakai") }
  private var port: UInt16 = 0
  private var splashView: NSView?
  private var failureView: NSView?
  private var ringkasanGalat = ""

  override func loadView() {
    view = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820))
    view.wantsLayer = true
  }

  // MARK: - Keadaan

  func showSplash(_ teks: String) {
    bersihkanOverlay()
    let spin = NSProgressIndicator()
    spin.style = .spinning
    spin.startAnimation(nil)
    let label = NSTextField(labelWithString: teks)
    label.textColor = .secondaryLabelColor
    let stack = NSStackView(views: [spin, label])
    stack.orientation = .vertical
    stack.spacing = 12
    pasangOverlay(stack, simpan: \.splashView)
  }

  func showFailure(title: String, detail: String) {
    bersihkanOverlay()
    ringkasanGalat = "\(title)\n\n\(detail)"
    let judul = NSTextField(labelWithString: title)
    judul.font = .boldSystemFont(ofSize: 18)
    let teks = NSTextView()
    teks.string = detail.isEmpty ? L("error.no_output", "(tak ada keluaran dari server)") : detail
    teks.isEditable = false
    teks.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    let gulung = NSScrollView()
    gulung.documentView = teks
    gulung.hasVerticalScroller = true
    gulung.borderType = .lineBorder
    gulung.translatesAutoresizingMaskIntoConstraints = false
    gulung.widthAnchor.constraint(equalToConstant: 620).isActive = true
    gulung.heightAnchor.constraint(equalToConstant: 260).isActive = true
    let coba = NSButton(title: L("button.retry", "Coba lagi"), target: self, action: #selector(cobaLagi))
    coba.keyEquivalent = "\r"
    let salin = NSButton(title: L("button.copy", "Salin"), target: self, action: #selector(salinGalat))
    let baris = NSStackView(views: [coba, salin])
    baris.spacing = 8
    let stack = NSStackView(views: [judul, gulung, baris])
    stack.orientation = .vertical
    stack.spacing = 14
    pasangOverlay(stack, simpan: \.failureView)
  }

  func showWeb(port: UInt16, enterURL: String) {
    bersihkanOverlay()
    self.port = port
    bridge.port = port
    let wv = webView ?? buatWebView()
    webView = wv
    wv.isHidden = false
    if let url = URL(string: enterURL) { wv.load(URLRequest(url: url)) }
  }

  func reload() { webView?.reload() }
  func zoom(by delta: CGFloat) {
    guard let wv = webView else { return }
    wv.pageZoom = min(3, max(0.5, wv.pageZoom + delta))
  }
  func zoomReset() { webView?.pageZoom = 1 }

  // MARK: - Internal

  @objc private func cobaLagi() { onRetry?() }
  @objc private func salinGalat() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(ringkasanGalat, forType: .string)
  }

  private func bersihkanOverlay() {
    splashView?.removeFromSuperview(); splashView = nil
    failureView?.removeFromSuperview(); failureView = nil
    webView?.isHidden = true
  }

  private func pasangOverlay(_ v: NSView, simpan: ReferenceWritableKeyPath<ContentController, NSView?>) {
    v.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(v)
    NSLayoutConstraint.activate([
      v.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      v.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    self[keyPath: simpan] = v
  }

  private func buatWebView() -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()  // persisten: cookie sesi 30 hari bertahan
    bridge.pasang(di: config.userContentController)
    let wv = WKWebView(frame: view.bounds, configuration: config)
    wv.autoresizingMask = [.width, .height]
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = false
    if #available(macOS 13.3, *) {
      wv.isInspectable = ProcessInfo.processInfo.environment["JEJAK_DEBUG"] == "1"
    }
    view.addSubview(wv, positioned: .below, relativeTo: nil)
    return wv
  }

  fileprivate func bukaEksternal(_ url: String) {
    if let target = NavigationPolicy.externalOpenTarget(url, port: port), let u = URL(string: target) {
      NSWorkspace.shared.open(u)
    }
  }
}

extension ContentController: WKNavigationDelegate {
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    let url = navigationAction.request.url?.absoluteString ?? ""
    if NavigationPolicy.isAllowedNavigation(url, port: port) {
      decisionHandler(.allow)
    } else {
      bukaEksternal(url)
      decisionHandler(.cancel)
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    // Proses render mati (mis. kehabisan memori): muat ulang, jangan biarkan kosong.
    webView.reload()
  }
}

extension ContentController: WKUIDelegate {
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url?.absoluteString { bukaEksternal(url) }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert(); a.messageText = message
    a.addButton(withTitle: L("button.ok", "OK")); a.addButton(withTitle: L("button.cancel", "Batal"))
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping (String?) -> Void) {
    let a = NSAlert(); a.messageText = prompt
    a.addButton(withTitle: L("button.ok", "OK")); a.addButton(withTitle: L("button.cancel", "Batal"))
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = parameters.allowsDirectories
    p.canChooseFiles = true
    p.begin { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  /// Mikrofon (dikte) hanya untuk halaman Jejak di loopback.
  func webView(_ webView: WKWebView,
               requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping (WKPermissionDecision) -> Void) {
    let ok = origin.protocol == "http" && origin.host == NavigationPolicy.loopback
      && origin.port == Int(port)
    decisionHandler(ok ? .grant : .deny)
  }
}
