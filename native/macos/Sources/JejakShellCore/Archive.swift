import Foundation

/// Ekstraksi arsip pembaruan (`.app.tar.gz`) yang aman.
enum Archive {
  struct Hasil { let status: Int32; let keluaran: String }

  static func run(_ exe: String, _ args: [String]) throws -> Hasil {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let pipa = Pipe()
    p.standardOutput = pipa
    p.standardError = pipa
    try p.run()
    // Kuras sebelum menunggu supaya keluaran besar tak memblokir proses.
    let data = pipa.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return Hasil(status: p.terminationStatus, keluaran: String(decoding: data, as: UTF8.self))
  }

  /// Entri arsip aman bila relatif, tanpa `..`, dan semuanya di bawah satu `*.app`.
  static func isSafe(entries: [String]) -> String? {
    var akar: String?
    for e in entries where !e.isEmpty {
      if e.hasPrefix("/") { return nil }
      let bagian = e.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
      if bagian.contains("..") || bagian.isEmpty { return nil }
      guard bagian[0].hasSuffix(".app") else { return nil }
      if let a = akar, a != bagian[0] { return nil }
      akar = bagian[0]
    }
    return akar
  }

  /// Mengekstrak ke `folder` dan mengembalikan URL `.app` di dalamnya.
  static func extractApp(_ arsip: URL, into folder: URL) throws -> URL {
    let daftar = try run("/usr/bin/tar", ["-tzf", arsip.path])
    guard daftar.status == 0 else {
      throw MinisignError(description: L("update.extract", "arsip pembaruan tak bisa dibuka"))
    }
    let entri = daftar.keluaran.split(separator: "\n").map(String.init)
    guard let nama = isSafe(entries: entri) else {
      throw MinisignError(description: L("update.unsafe", "isi arsip pembaruan tak aman"))
    }
    let ekstrak = try run("/usr/bin/tar", ["-xzf", arsip.path, "-C", folder.path])
    guard ekstrak.status == 0 else {
      throw MinisignError(description: L("update.extract", "arsip pembaruan tak bisa dibuka"))
    }
    return folder.appendingPathComponent(nama)
  }
}

/// Unduhan berkas dengan laporan progres, termasuk URL file:// (untuk tes).
final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private let tujuan: URL
  private let progres: @Sendable (UInt64, UInt64?) -> Void
  private var lanjut: CheckedContinuation<Void, Error>?
  private var selesai = false
  private let lock = NSLock()

  private init(tujuan: URL, progres: @escaping @Sendable (UInt64, UInt64?) -> Void) {
    self.tujuan = tujuan
    self.progres = progres
  }

  static func download(
    _ url: URL, to tujuan: URL, session base: URLSession,
    progress: @escaping @Sendable (UInt64, UInt64?) -> Void
  ) async throws {
    let d = Downloader(tujuan: tujuan, progres: progress)
    let sesi = URLSession(configuration: base.configuration, delegate: d, delegateQueue: nil)
    defer { sesi.finishTasksAndInvalidate() }
    try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
      d.lock.lock(); d.lanjut = k; d.lock.unlock()
      sesi.downloadTask(with: url).resume()
    }
  }

  private func akhiri(_ galat: Error?) {
    lock.lock()
    guard !selesai, let k = lanjut else { lock.unlock(); return }
    selesai = true; lanjut = nil
    lock.unlock()
    if let galat { k.resume(throwing: galat) } else { k.resume() }
  }

  func urlSession(_ s: URLSession, downloadTask t: URLSessionDownloadTask, didWriteData _: Int64,
                  totalBytesWritten w: Int64, totalBytesExpectedToWrite e: Int64) {
    progres(UInt64(max(0, w)), e > 0 ? UInt64(e) : nil)
  }

  func urlSession(_ s: URLSession, downloadTask t: URLSessionDownloadTask, didFinishDownloadingTo lokasi: URL) {
    if let http = t.response as? HTTPURLResponse, http.statusCode != 200 {
      akhiri(MinisignError(description: L("update.http", "server pembaruan menjawab %@", "\(http.statusCode)")))
      return
    }
    do {
      try? FileManager.default.removeItem(at: tujuan)
      try FileManager.default.moveItem(at: lokasi, to: tujuan)
      akhiri(nil)
    } catch { akhiri(error) }
  }

  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error { akhiri(error) }
  }
}
