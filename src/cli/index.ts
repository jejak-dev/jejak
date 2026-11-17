#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { isLiteralIpHost, isLoopbackHost, parseArgs } from "./args";
import { installDesktopLifecycle } from "./desktop";
import { runDoctor } from "./doctor";
import { startServer } from "../server";
import { resolvePassword, type PasswordVerifier } from "../server/auth/password";
import { createStoreVerifier, defaultPasswordStore } from "../server/auth/password-store";
import {
  DESKTOP_READY_PREFIX,
  generateDesktopPassword,
  readDesktopToken,
} from "../server/desktop";
import { jejakHome } from "../server/provider-store";
import { DataVersionError, prepareDataDir } from "../server/data-version";
import { VERSION } from "../shared/version";

const HELP = `jejak ${VERSION}

Pemakaian:
  jejak serve                       jalankan server (default 127.0.0.1:3000)
  jejak serve --port 3001           ganti port
  jejak serve --port=3001 --host 127.0.0.1
  jejak serve --mock                pakai agent tiruan (tanpa SDK)
  jejak doctor                      periksa lingkungan
  jejak --version                   tampilkan versi
  jejak --help                      tampilkan bantuan

Autentikasi (opsional):
  --password auto                  buat kata sandi acak, cetak sekali di stdout
  --password-file <path>           baca kata sandi dari berkas
  --allow-host <host>              host yang diizinkan; boleh diulang
  --insecure-no-auth               izinkan bind non-loopback tanpa kata sandi
  --tls-cert <path> --tls-key <p>  HTTPS dengan sertifikat sendiri (harus berpasangan)

Mode cangkang aplikasi (bukan pemakaian manual):
  --desktop                         mode sidecar untuk cangkang aplikasi desktop:
                                    port acak, masuk lewat /__desktop/enter,
                                    dan proses berhenti saat induknya berhenti

Variabel lingkungan:
  HOST           alamat binding server (default 127.0.0.1)
  PORT           port server (default 3000; 0 = acak, hanya dengan --desktop)
  MOCK           "true" untuk agent tiruan; sama dengan --mock
  JEJAK_HOME     folder data Jejak (default ~/.jejak)
  JEJAK_PERSIST  "0" untuk mematikan penyimpanan sesi
  JEJAK_PASSWORD kata sandi untuk masuk (sama dengan --password-file)
  JEJAK_DESKTOP_TOKEN  token masuk mode --desktop (minimal 32 karakter)
  JEJAK_SKIP_BACKUP  "1" untuk melewati cadangan data sebelum naik versi

Prioritas: flag > variabel lingkungan > default.
`;

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case "serve": {
    if (args.error !== undefined) {
      console.error(`${args.error}\n`);
      console.error(HELP);
      process.exit(1);
    }
    const host = args.host ?? envValue("HOST") ?? "127.0.0.1";
    const desktop = args.desktop === true;
    // Mode desktop memakai port acak dari OS sebagai bawaan.
    const port = desktop
      ? (args.port ?? envPort("PORT", true) ?? 0)
      : (args.port ?? envPort("PORT") ?? 3000);
    const loopback = isLoopbackHost(host);
    const literalHost = isLiteralIpHost(host);
    const allowHosts = [...(args.allowHosts ?? [])];
    // Host binding berupa IP literal boleh dipakai langsung.
    if (!loopback && literalHost) allowHosts.push(host);

    if (desktop && !loopback) {
      console.error(
        `Mode --desktop hanya boleh mendengarkan host loopback (127.0.0.1). Diterima: ${host}.`,
      );
      process.exit(1);
    }
    if (desktop && allowHosts.length > 0) {
      // Mode desktop tak punya jalur keluar lewat --allow-host.
      allowHosts.length = 0;
      console.error("Catatan: mode --desktop mengabaikan --allow-host.");
    }

    const envPasswordSet = envValue("JEJAK_PASSWORD") !== undefined;
    let password: string | PasswordVerifier | undefined;
    let desktopToken: string | undefined;
    let generated = false;
    if (desktop) {
      // Autentikasi internal: kata sandi acak yang tak pernah dicetak dan
      // tak bisa ditebak. Sandi dari lingkungan juga tak diwarisi ke anak.
      delete process.env.JEJAK_PASSWORD;
      if (args.password !== undefined || args.passwordFile !== undefined) {
        console.error(
          "Catatan: mode --desktop memakai kata sandi internal acak; --password diabaikan.",
        );
      }
      password = generateDesktopPassword();
      try {
        desktopToken = readDesktopToken(process.env);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    } else {
      try {
        password = resolvePassword({
          ...(args.passwordFile === undefined ? {} : { passwordFile: args.passwordFile }),
          env: process.env,
          ...(args.password === "auto" ? { auto: true } : {}),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      // Sandi tidak boleh diwarisi proses anak (agent, Bash, terminal).
      delete process.env.JEJAK_PASSWORD;
      generated =
        args.password === "auto" &&
        args.passwordFile === undefined &&
        !envPasswordSet;
      if (
        args.password === "auto" &&
        args.passwordFile === undefined &&
        envPasswordSet
      ) {
        console.error("Catatan: JEJAK_PASSWORD aktif, --password auto diabaikan.");
      }
      // Tanpa sandi dari flag atau env: pakai sandi tersimpan milik pengguna
      // (dibuat di Pengaturan) sebagai sumber autentikasi.
      if (password === undefined && args.insecureNoAuth !== true) {
        const store = defaultPasswordStore(process.env);
        if (store.has()) {
          password = createStoreVerifier(store);
        }
      }
    }

    if (!loopback) {
      if (password === undefined) {
        if (args.insecureNoAuth !== true) {
          console.error(
            `Server mendengarkan ${host} sehingga terbuka ke jaringan, tapi tidak ada kata sandi. ` +
              "Gunakan --password auto, --password-file <path>, atau variabel JEJAK_PASSWORD. " +
              "Kalau memang ingin membuka tanpa autentikasi, tambahkan --insecure-no-auth (berisiko).",
          );
          process.exit(1);
        }
        console.error(
          "PERINGATAN KERAS: Jejak dibuka ke jaringan TANPA autentikasi. " +
            "Siapa pun yang bisa mencapai port ini bisa menjalankan agent, membaca berkas, " +
            "dan memakai kunci penyedia.",
        );
        if (allowHosts.length === 0) {
          console.error(
            "Catatan: hanya host 127.0.0.1/localhost yang diizinkan. " +
              "Tambahkan --allow-host <nama> agar bisa diakses dari perangkat lain.",
          );
        }
      } else if (allowHosts.length === 0) {
        console.error(
          `Server mendengarkan ${host} (bukan IP literal), jadi daftar host yang diizinkan ` +
            "belum pasti. Tambahkan --allow-host <host> (mis. --allow-host jejak.lan) " +
            "agar proteksi anti-DNS-rebinding tetap berlaku.",
        );
        process.exit(1);
      }
    }

    let tls: { cert: string; key: string } | undefined;
    if (args.tlsCert !== undefined && args.tlsKey !== undefined) {
      try {
        tls = {
          cert: readFileSync(args.tlsCert, "utf8"),
          key: readFileSync(args.tlsKey, "utf8"),
        };
      } catch (error) {
        console.error(
          `Tidak bisa membaca sertifikat TLS: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    } else if (!loopback) {
      console.error(
        "Peringatan: tanpa TLS, kata sandi dan cookie sesi dikirim sebagai teks biasa di jaringan. " +
          "Pakai --tls-cert/--tls-key atau reverse proxy.",
      );
    }

    if (args.mock === true) {
      process.env.MOCK = "true";
    }
    if (generated && password !== undefined) {
      console.log(`Kata sandi Jejak (hanya ditampilkan sekali): ${password}`);
    }
    // Penjaga versi data: dijalankan sekali sebelum penyimpanan dibuka dan
    // sebelum server mendengarkan, supaya data tak pernah disentuh aplikasi
    // yang salah versi.
    let infoCadangan = "";
    try {
      const prep = await prepareDataDir({
        home: jejakHome(process.env),
        appVersion: VERSION,
        env: process.env,
      });
      if (prep.action === "upgraded" || prep.action === "legacy") {
        infoCadangan =
          prep.backupDir === undefined
            ? `Data naik versi dari ${prep.from} ke ${VERSION} tanpa cadangan (JEJAK_SKIP_BACKUP=1)`
            : `Data dicadangkan ke ${prep.backupDir} sebelum naik dari ${prep.from} ke ${VERSION}`;
      }
    } catch (error) {
      if (error instanceof DataVersionError) {
        console.error(error.message);
        if (error.code === "newer") {
          // Bantu mengenali salinan aplikasi ganda (mis. /Applications vs ~/Applications).
          console.error(`Aplikasi yang berjalan: ${process.execPath}`);
        }
        process.exit(1);
      }
      throw error;
    }
    if (infoCadangan !== "") {
      // Di mode desktop stdout dipakai baris JEJAK_READY; info ditulis ke stderr.
      if (desktop) console.error(infoCadangan);
      else console.log(infoCadangan);
    }
    const handle = startServer({
      host,
      port,
      ...(password === undefined ? {} : { password }),
      ...(allowHosts.length === 0 ? {} : { allowHosts }),
      ...(tls === undefined ? {} : { tls }),
      ...(desktopToken === undefined ? {} : { desktopToken }),
    });
    console.log(`Data: ${jejakHome()}`);
    if (desktop) {
      // Pengumuman siap: satu baris, dibaca mesin oleh cangkang aplikasi.
      console.log(
        `${DESKTOP_READY_PREFIX} ${JSON.stringify({
          port: handle.port,
          host: handle.host,
          version: VERSION,
        })}`,
      );
      installDesktopLifecycle({
        stop: () => {
          void handle.stop();
        },
      });
    }
    break;
  }
  case "doctor": {
    if (args.error !== undefined) {
      console.error(`${args.error}\n`);
      console.error(HELP);
      process.exit(1);
    }
    process.exit(await runDoctor());
    break;
  }
  case "version":
    console.log(VERSION);
    break;
  case "help":
    console.log(HELP);
    break;
  case "unknown":
    console.error(`Perintah atau flag tidak dikenal: ${args.unknown ?? ""}\n`);
    console.error(HELP);
    process.exit(1);
    break;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function envPort(name: string, allowZero = false): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  const min = allowZero ? 0 : 1;
  return Number.isInteger(value) && value >= min && value <= 65535 ? value : undefined;
}
