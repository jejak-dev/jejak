import AppKit

extension AppDelegate {
  /// Menu aplikasi. Menu Edit wajib ada agar Cmd+C/V/X/A/Z bekerja di WKWebView.
  func pasangMenu() {
    let utama = NSMenu()
    func item(_ judul: String, _ aksi: Selector?, _ kunci: String = "",
              _ mod: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: judul, action: aksi, keyEquivalent: kunci)
      i.keyEquivalentModifierMask = mod
      i.target = target
      return i
    }
    func submenu(_ judul: String, _ items: [NSMenuItem]) -> NSMenuItem {
      let m = NSMenu(title: judul)
      items.forEach { m.addItem($0) }
      let wadah = NSMenuItem(title: judul, action: nil, keyEquivalent: "")
      wadah.submenu = m
      return wadah
    }

    let app = submenu("Jejak", [
      item("Tentang Jejak", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item("Sembunyikan Jejak", #selector(NSApplication.hide(_:)), "h"),
      item("Sembunyikan Lainnya", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Tampilkan Semua", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Keluar dari Jejak", #selector(NSApplication.terminate(_:)), "q"),
    ])
    let edit = submenu("Edit", [
      item("Urungkan", Selector(("undo:")), "z"),
      item("Ulangi", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Potong", #selector(NSText.cut(_:)), "x"),
      item("Salin", #selector(NSText.copy(_:)), "c"),
      item("Tempel", #selector(NSText.paste(_:)), "v"),
      item("Pilih Semua", #selector(NSText.selectAll(_:)), "a"),
    ])
    let tampilan = submenu("Tampilan", [
      item("Muat Ulang", #selector(AppDelegate.muatUlang(_:)), "r", target: self),
      .separator(),
      item("Perbesar", #selector(AppDelegate.perbesar(_:)), "+", target: self),
      item("Perkecil", #selector(AppDelegate.perkecil(_:)), "-", target: self),
      item("Ukuran Asli", #selector(AppDelegate.ukuranAsli(_:)), "0", target: self),
      .separator(),
      item("Layar Penuh", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let jendela = submenu("Jendela", [
      item("Minimalkan", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
    ])
    for m in [app, edit, tampilan, jendela] { utama.addItem(m) }
    NSApp.mainMenu = utama
    NSApp.windowsMenu = jendela.submenu
  }
}
