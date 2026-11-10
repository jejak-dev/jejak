#!/usr/bin/env bun
import { isLoopbackHost, parseArgs } from "./args";
import { runDoctor } from "./doctor";
import { startServer } from "../server";
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

Variabel lingkungan:
  HOST           alamat binding server (default 127.0.0.1)
  PORT           port server (default 3000)
  MOCK           "true" untuk agent tiruan; sama dengan --mock
  JEJAK_HOME     folder data Jejak (default ~/.jejak)
  JEJAK_PERSIST  "0" untuk mematikan penyimpanan sesi

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
    if (!isLoopbackHost(host)) {
      console.error(
        `Peringatan: server mendengarkan ${host} sehingga terbuka ke jaringan. ` +
          "Jejak belum punya autentikasi; jangan membukanya ke jaringan (lihat AGENTS.md).",
      );
    }
    if (args.mock === true) {
      process.env.MOCK = "true";
    }
    startServer({ host, port });
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
