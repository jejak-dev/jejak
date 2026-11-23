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
      item(L("menu.about", "Tentang Jejak"), #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      item(L("menu.hide", "Sembunyikan Jejak"), #selector(NSApplication.hide(_:)), "h"),
      item(L("menu.hide_others", "Sembunyikan Lainnya"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item(L("menu.show_all", "Tampilkan Semua"), #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item(L("menu.quit", "Keluar dari Jejak"), #selector(NSApplication.terminate(_:)), "q"),
    ])
    let edit = submenu(L("menu.edit", "Edit"), [
      item(L("menu.undo", "Urungkan"), Selector(("undo:")), "z"),
      item(L("menu.redo", "Ulangi"), Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item(L("menu.cut", "Potong"), #selector(NSText.cut(_:)), "x"),
      item(L("menu.copy", "Salin"), #selector(NSText.copy(_:)), "c"),
      item(L("menu.paste", "Tempel"), #selector(NSText.paste(_:)), "v"),
      item(L("menu.select_all", "Pilih Semua"), #selector(NSText.selectAll(_:)), "a"),
    ])
    let tampilan = submenu(L("menu.view", "Tampilan"), [
      item(L("menu.reload", "Muat Ulang"), #selector(AppDelegate.muatUlang(_:)), "r", target: self),
      .separator(),
      item(L("menu.zoom_in", "Perbesar"), #selector(AppDelegate.perbesar(_:)), "+", target: self),
      item(L("menu.zoom_out", "Perkecil"), #selector(AppDelegate.perkecil(_:)), "-", target: self),
      item(L("menu.zoom_reset", "Ukuran Asli"), #selector(AppDelegate.ukuranAsli(_:)), "0", target: self),
      .separator(),
      item(L("menu.fullscreen", "Layar Penuh"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    let jendela = submenu(L("menu.window", "Jendela"), [
      item(L("menu.minimize", "Minimalkan"), #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
    ])
    for m in [app, edit, tampilan, jendela] { utama.addItem(m) }
    NSApp.mainMenu = utama
    NSApp.windowsMenu = jendela.submenu
  }
}
