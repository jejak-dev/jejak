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
await run("Blake2bTests.vektorResmi") { try await Blake2bTests().vektorResmi() }
await run("Blake2bTests.streaming") { try await Blake2bTests().streamingSamaDenganSekaliJalan() }
await run("Blake2bTests.blokJamak") { try await Blake2bTests().vektorBlokJamak() }
await run("MinisignTests.sah") { try await MinisignTests().berkasSahLolos() }
await run("MinisignTests.berkasDiubah") { try await MinisignTests().berkasDiubahDitolak() }
await run("MinisignTests.kunciLain") { try await MinisignTests().kunciLainDitolak() }
await run("MinisignTests.trustedComment") { try await MinisignTests().trustedCommentDiubahDitolak() }
await run("MinisignTests.masukanRusak") { try await MinisignTests().masukanRusakDitolak() }
await run("MinisignTests.dariDisk") { try await MinisignTests().berkasDariDisk() }
await run("SemverTests.urutan") { try await SemverTests().urutan() }
await run("SemverTests.tidakSah") { try await SemverTests().tidakSah() }
await run("UpdaterTests.periksaMenemukanVersiBaru") { try await UpdaterTests().periksaMenemukanVersiBaru() }
await run("UpdaterTests.versiSamaAtauLebihBaruTakDitawarkan") { try await UpdaterTests().versiSamaAtauLebihBaruTakDitawarkan() }
await run("UpdaterTests.tanpaArtefakNativeDiabaikan") { try await UpdaterTests().tanpaArtefakNativeDiabaikan() }
await run("UpdaterTests.pasangPenuhMenggantiBundel") { try await UpdaterTests().pasangPenuhMenggantiBundel() }
await run("UpdaterTests.tandaTanganSalahDitolakDanBundelUtuh") { try await UpdaterTests().tandaTanganSalahDitolakDanBundelUtuh() }
await run("UpdaterTests.aplikasiLainDitolak") { try await UpdaterTests().aplikasiLainDitolak() }
await run("UpdaterTests.versiArsipTakSesuaiManifestDitolak") { try await UpdaterTests().versiArsipTakSesuaiManifestDitolak() }
await run("UpdaterTests.pasangTanpaPemeriksaanDitolak") { try await UpdaterTests().pasangTanpaPemeriksaanDitolak() }
await run("UpdaterTests.httpTanpaOverrideDitolak") { try await UpdaterTests().httpTanpaOverrideDitolak() }
await run("UpdaterTests.kanalTakDikenal") { try await UpdaterTests().kanalTakDikenal() }
await run("UpdaterTests.arsipTakAmanDitolak") { try await UpdaterTests().arsipTakAmanDitolak() }
await run("UpdaterTests.argumenMulaiUlang") { try await UpdaterTests().argumenMulaiUlang() }
await run("PengaturanPembaruTests.kanalBawaan") { try await PengaturanPembaruTests().kanalBawaan() }
await run("PengaturanPembaruTests.transisiStatus") { try await PengaturanPembaruTests().transisiStatus() }
await run("PengaturanPembaruTests.manifestRusak") { try await PengaturanPembaruTests().manifestRusak() }

finish()
