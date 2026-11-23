import Foundation

nonisolated(unsafe) var gagalSekarang: [String] = []
nonisolated(unsafe) var totalGagal = 0
nonisolated(unsafe) var totalLulus = 0

struct GalatUji: Error, CustomStringConvertible { let description: String }

func expect(_ kondisi: @autoclosure () -> Bool, line: Int = #line) {
  if !kondisi() { gagalSekarang.append("baris \(line): ekspektasi gagal") }
}
func fail(_ pesan: String, line: Int = #line) { gagalSekarang.append("baris \(line): \(pesan)") }
func expectThrows(line: Int = #line, _ blok: () throws -> Any?) {
  do { _ = try blok(); gagalSekarang.append("baris \(line): seharusnya melempar galat") } catch {}
}
func require<T>(_ nilai: T?, line: Int = #line) throws -> T {
  guard let nilai else { throw GalatUji(description: "baris \(line): nilai nil") }
  return nilai
}

func run(_ nama: String, _ blok: () async throws -> Void) async {
  gagalSekarang = []
  do { try await blok() } catch { gagalSekarang.append("galat: \(error)") }
  if gagalSekarang.isEmpty {
    totalLulus += 1
    print("  lulus  \(nama)")
  } else {
    totalGagal += 1
    print("  GAGAL  \(nama)")
    for g in gagalSekarang { print("         \(g)") }
  }
}

func finish() -> Never {
  print("\n\(totalLulus) lulus, \(totalGagal) gagal")
  exit(totalGagal == 0 ? 0 : 1)
}
