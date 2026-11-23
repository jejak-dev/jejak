import Foundation

/// Penyangga baris berkapasitas tetap (stderr sidecar), aman lintas thread.
public final class LineRingBuffer: @unchecked Sendable {
  public let capacity: Int
  private var lines: [String] = []
  private let lock = NSLock()

  public init(capacity: Int = 200) {
    self.capacity = max(1, capacity)
  }

  public func append(_ line: String) {
    lock.lock()
    defer { lock.unlock() }
    if lines.count >= capacity { lines.removeFirst(lines.count - capacity + 1) }
    lines.append(line)
  }

  public var snapshot: [String] {
    lock.lock()
    defer { lock.unlock() }
    return lines
  }

  /// Ringkasan untuk pesan galat; kosong bila tak ada keluaran.
  public func summary(maxLines: Int = 40) -> String {
    let semua = snapshot
    let ekor = semua.suffix(maxLines)
    return ekor.joined(separator: "\n")
  }
}
