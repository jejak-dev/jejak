import { describe, expect, test } from "bun:test";
import {
  COMMAND_ENV_REASON,
  checkSecretAccess,
  type SecretAccessVerdict,
} from "../src/server/security/secret-paths";

const KEYS = ["DB_PASSWORD", "DB_HOST"];

function bash(command: string, keys: readonly string[] = KEYS): SecretAccessVerdict {
  return checkSecretAccess(
    { toolName: "Bash", toolInput: { command }, cwd: "/proyek/uji" },
    { commandEnv: { keys } },
  );
}

test("menolak perintah yang menampilkan env", () => {
  for (const command of [
    "env",
    "printenv DB_PASSWORD",
    "echo $DB_PASSWORD",
    'echo "${DB_PASSWORD}"',
    "export -p",
    "declare -p",
    "typeset -p",
    "compgen -v",
    "set",
    "cat /proc/self/environ",
    "ls && env",
  ]) {
    const verdict = bash(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toBe(COMMAND_ENV_REASON);
    expect(verdict.rule).toBe("env-perintah");
  }
});

test("mengizinkan pemakaian variabel tanpa menampilkannya", () => {
  for (const command of [
    "psql -h $DB_HOST -c 'select 1'",
    "bun run cek-db.ts",
    "echo halo",
    "set -e; bun test",
  ]) {
    expect(bash(command).blocked).toBe(false);
  }
});

test("tanpa commandEnv perilaku lama tak berubah", () => {
  const verdict = checkSecretAccess({
    toolName: "Bash",
    toolInput: { command: "env" },
    cwd: "/proyek/uji",
  });
  expect(verdict.blocked).toBe(false);
});

test("menolak perintah yang menyebut rute command-env", () => {
  const verdict = bash("curl http://127.0.0.1:3000/api/sessions/x/command-env");
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("command-env-api");
});

describe("berkas env perintah bernama bebas tetap tertutup", () => {
  const opsi = { commandEnv: { keys: ["DB_PASSWORD"], file: "/proyek-lain/staging.env" } };

  test("Read berkas itu ditolak", () => {
    const v = checkSecretAccess(
      { toolName: "Read", toolInput: { file_path: "/proyek-lain/staging.env" }, cwd: "/proyek" },
      opsi,
    );
    expect(v.blocked).toBe(true);
  });

  test("cat berkas itu lewat Bash ditolak", () => {
    const v = checkSecretAccess(
      { toolName: "Bash", toolInput: { command: "cat /proyek-lain/staging.env" }, cwd: "/proyek" },
      opsi,
    );
    expect(v.blocked).toBe(true);
  });

  test("berkas lain tak terpengaruh", () => {
    const v = checkSecretAccess(
      { toolName: "Read", toolInput: { file_path: "/proyek/README.md" }, cwd: "/proyek" },
      opsi,
    );
    expect(v.blocked).toBe(false);
  });
});
