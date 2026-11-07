#!/usr/bin/env bun
import { VERSION } from "../shared/version";
import { startServer } from "../server";
import { runDoctor } from "./doctor";

const HELP = `jejak ${VERSION}

Pemakaian:
  jejak serve       jalankan server (HOST, PORT dapat diatur lewat env)
  jejak doctor      periksa lingkungan
  jejak --version   tampilkan versi
  jejak --help      tampilkan bantuan
`;

const [command] = process.argv.slice(2);

switch (command) {
  case "serve":
    startServer();
    break;
  case "doctor":
    process.exit(await runDoctor());
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  case undefined:
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Perintah tidak dikenal: ${command}\n`);
    console.error(HELP);
    process.exit(1);
}
