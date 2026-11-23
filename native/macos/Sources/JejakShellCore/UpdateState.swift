import Foundation

/// Tahap pembaruan; nilai mentah dipakai UI web (kontrak `desktop.ts`).
public enum UpdatePhase: String, Sendable {
  case idle, checking, available, downloading, installing, ready, error
}

/// Keadaan pembaruan yang dilihat UI.
public struct UpdateStatus: Equatable, Sendable {
  public var state: UpdatePhase = .idle
  public var version: String?
  public var notes: String?
  public var date: String?
  public var downloaded: UInt64 = 0
  public var total: UInt64?
  public var error: String?
  public var lastCheck: UInt64?

  public init() {}

  /// Bentuk JSON untuk jembatan (`updater_status`), kunci camelCase.
  public var json: [String: Any] {
    var d: [String: Any] = ["state": state.rawValue, "downloaded": downloaded]
    if let version { d["version"] = version }
    if let notes { d["notes"] = notes }
    if let date { d["date"] = date }
    if let total { d["total"] = total }
    if let error { d["error"] = error }
    if let lastCheck { d["lastCheck"] = lastCheck }
    return d
  }
}

/// Peristiwa yang mengubah status.
public enum UpdateEvent: Equatable, Sendable {
  case startCheck(at: UInt64)
  case finishCheck(at: UInt64, version: String?, notes: String?, date: String?)
  case startDownload
  case progress(downloaded: UInt64, total: UInt64?)
  case finishDownload
  case finishInstall
  case fail(at: UInt64, message: String)
  case dropPending
}

public extension UpdateStatus {
  /// Menerapkan peristiwa; mengembalikan true bila status berubah.
  /// Aturan transisi sama dengan modul Rust (`terapkan`).
  @discardableResult
  mutating func apply(_ e: UpdateEvent) -> Bool {
    switch e {
    case .startCheck(let at):
      guard state == .idle || state == .error else { return false }
      state = .checking
      version = nil; notes = nil; date = nil
      downloaded = 0; total = nil; error = nil
      lastCheck = at
      return true
    case .finishCheck(let at, let v, let n, let d):
      guard state == .checking else { return false }
      lastCheck = at; error = nil
      if let v {
        state = .available; version = v; notes = n; date = d
      } else {
        state = .idle; version = nil; notes = nil; date = nil
      }
      return true
    case .startDownload:
      guard state == .available else { return false }
      state = .downloading; downloaded = 0; total = nil; error = nil
      return true
    case .progress(let got, let tot):
      guard state == .downloading else { return false }
      downloaded = got; total = tot
      return true
    case .finishDownload:
      guard state == .downloading else { return false }
      state = .installing
      return true
    case .finishInstall:
      guard state == .installing else { return false }
      state = .ready
      return true
    case .fail(let at, let message):
      let sebelumnya = state
      state = .error
      error = message
      if sebelumnya == .checking { lastCheck = at }
      return true
    case .dropPending:
      guard state == .available else { return false }
      state = .idle; version = nil; notes = nil; date = nil
      return true
    }
  }
}
