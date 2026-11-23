import Foundation

/// Teks tampilan yang dilokalkan (id/en) lewat `Localizable.strings` di bundel
/// aplikasi. `bawaan` adalah teks Indonesia: dipakai bila tabel tak ada (mis.
/// saat tes berjalan di luar bundel .app) sehingga pesan tak pernah berupa kunci.
public func L(_ kunci: String, _ bawaan: String, _ args: String...) -> String {
  let format = NSLocalizedString(kunci, value: bawaan, comment: "")
  guard !args.isEmpty else { return format }
  // Ganti %@ berurutan; tak memakai String(format:) agar nilai dengan '%' aman.
  var hasil = ""
  var sisa = Substring(format)
  var i = 0
  while let r = sisa.range(of: "%@") {
    hasil += sisa[..<r.lowerBound]
    hasil += i < args.count ? args[i] : ""
    i += 1
    sisa = sisa[r.upperBound...]
  }
  return hasil + sisa
}
