import AppKit

// Titik masuk cangkang native Jejak (AppKit + WKWebView).
// Mode bahasa Swift 5 untuk target ini: delegasi AppKit/WebKit belum rapi
// di concurrency ketat; logika yang perlu aman-thread ada di JejakShellCore (Swift 6).
let aplikasi = NSApplication.shared
let delegasi = MainActor.assumeIsolated { AppDelegate() }
aplikasi.delegate = delegasi
aplikasi.setActivationPolicy(.regular)
aplikasi.run()
