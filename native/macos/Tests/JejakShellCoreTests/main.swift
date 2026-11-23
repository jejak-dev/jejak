// Titik masuk harness uji mini (swift-testing tak serasi dengan toolchain CLT).
import Foundation

await run("ReadyLineTests.barisSahDibaca") { try await ReadyLineTests().barisSahDibaca() }
await run("ReadyLineTests.barisBiasaDiabaikan") { try await ReadyLineTests().barisBiasaDiabaikan() }
await run("ReadyLineTests.tanpaPayloadGalat") { try await ReadyLineTests().tanpaPayloadGalat() }
await run("ReadyLineTests.jsonRusakGalat") { try await ReadyLineTests().jsonRusakGalat() }
await run("ReadyLineTests.portDiLuarRentangGalat") { try await ReadyLineTests().portDiLuarRentangGalat() }
await run("ReadyLineTests.bawaanHostDanVersi") { try await ReadyLineTests().bawaanHostDanVersi() }
await run("TokenTests.tokenDibuatSah") { try await TokenTests().tokenDibuatSah() }
await run("TokenTests.tokenTakSah") { try await TokenTests().tokenTakSah() }
await run("NavigationTests.enterURL") { try await NavigationTests().enterURL() }
await run("NavigationTests.daftarPutih") { try await NavigationTests().daftarPutih() }
await run("NavigationTests.tautanEksternal") { try await NavigationTests().tautanEksternal() }
await run("RingBufferTests.menyimpan200Terakhir") { try await RingBufferTests().menyimpan200Terakhir() }
await run("SidecarProcessTests.siapLaluStopMematikanGrup") { try await SidecarProcessTests().siapLaluStopMematikanGrup() }
await run("SidecarProcessTests.berhentiSebelumSiapMembawaStderr") { try await SidecarProcessTests().berhentiSebelumSiapMembawaStderr() }
await run("SidecarProcessTests.timeout") { try await SidecarProcessTests().timeout() }
await run("SidecarProcessTests.tokenTidakBocorKeStderr") { try await SidecarProcessTests().tokenTidakBocorKeStderr() }
await run("SidecarProcessTests.sidecarAsli") { try await SidecarProcessTests().sidecarAsli() }

await run("LokalisasiTests.gantiArgumen") { try await LokalisasiTests().gantiArgumen() }

finish()
