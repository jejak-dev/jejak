#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { isLiteralIpHost, isLoopbackHost, parseArgs } from "./args";
import { runDoctor } from "./doctor";
import { startServer } from "../server";
import { resolvePassword } from "../server/auth/password";
import { jejakHome } from "../server/provider-store";
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

Variabel lingkungan:
  HOST           alamat binding server (default 127.0.0.1)
  PORT           port server (default 3000)
  MOCK           "true" untuk agent tiruan; sama dengan --mock
  JEJAK_HOME     folder data Jejak (default ~/.jejak)
  JEJAK_PERSIST  "0" untuk mematikan penyimpanan sesi
  JEJAK_PASSWORD kata sandi untuk masuk (sama dengan --password-file)

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
    const port = args.port ?? envPort("PORT") ?? 3000;
    const loopback = isLoopbackHost(host);
    const literalHost = isLiteralIpHost(host);
    const allowHosts = [...(args.allowHosts ?? [])];
    // Host binding berupa IP literal boleh dipakai langsung.
    if (!loopback && literalHost) allowHosts.push(host);

    let password: string | undefined;
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
    const envPasswordSet = envValue("JEJAK_PASSWORD") !== undefined;
    delete process.env.JEJAK_PASSWORD;
    const generated =
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
    startServer({
      host,
      port,
      ...(password === undefined ? {} : { password }),
      ...(allowHosts.length === 0 ? {} : { allowHosts }),
      ...(tls === undefined ? {} : { tls }),
    });
    console.log(`Data: ${jejakHome()}`);
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

function envPort(name: string): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}
