import { describe, expect, test } from "bun:test";
import { redactEnvFileText } from "../src/server/security/env-redact";
import { resolveSecretReadPath } from "../src/server/security/secret-paths";

const CWD = "/proyek/uji";
const HOME = "/rumah/uji";

const SAMPLE = [
  "# konfigurasi uji",
  "",
  "DB_HOST=staging.example.com",
  "DB_PORT=5432",
  "DB_NAME=app",
  "DB_USER=admin",
  "DB_PASSWORD=rahasia123",
  "API_TOKEN=tok3n-sangat-rahasia",
  'export SECRET_KEY="x y"',
  "DATABASE_URL=postgres://u:p@h:5432/db?sslmode=require&password=zzz",
  "EMPTY_KEY=",
].join("\n");

describe("redactEnvFileText", () => {
  test("nilai rahasia tidak muncul, nilai aman tampil", () => {
    const out = redactEnvFileText(SAMPLE);
    expect(out).not.toContain("rahasia123");
    expect(out).not.toContain("tok3n-sangat-rahasia");
    expect(out).not.toContain("x y");
    expect(out).not.toContain("u:p@");
    expect(out).not.toContain("zzz");
    expect(out).toContain("DB_HOST=staging.example.com");
    expect(out).toContain("DB_PORT=5432");
    expect(out).toContain("DB_NAME=app");
    expect(out).toContain("DB_USER=[disembunyikan");
    expect(out).toContain("DB_PASSWORD=[disembunyikan");
    expect(out).toContain("API_TOKEN=[disembunyikan");
    expect(out).toContain("SECRET_KEY=[disembunyikan");
    expect(out).toContain("EMPTY_KEY=");
  });

  test("URL tanpa userinfo, query hanya nama parameter", () => {
    const out = redactEnvFileText(SAMPLE);
    const line = out.split("\n").find((l) => l.startsWith("DATABASE_URL=")) ?? "";
    expect(line).toContain("postgres://[disembunyikan:kredensial]@h:5432/db");
    expect(line).not.toContain("u:p@");
    expect(line).toContain("sslmode=[disembunyikan]");
    expect(line).toContain("password=[disembunyikan]");
  });

  test("komentar dan baris kosong lewat apa adanya", () => {
    const out = redactEnvFileText(SAMPLE);
    expect(out.split("\n")[0]).toBe("# konfigurasi uji");
    expect(out.split("\n")[1]).toBe("");
  });
});

describe("resolveSecretReadPath", () => {
  const check = (toolName: string, toolInput: unknown) => ({
    toolName,
    toolInput,
    cwd: CWD,
    home: HOME,
  });

  test("Read .env -> jalur absolut", () => {
    expect(resolveSecretReadPath(check("Read", { file_path: ".env" }))).toBe(`${CWD}/.env`);
    expect(resolveSecretReadPath(check("Read", { file_path: ".env.local" }))).toBe(
      `${CWD}/.env.local`,
    );
  });

  test("Read .env.example -> undefined", () => {
    expect(resolveSecretReadPath(check("Read", { file_path: ".env.example" }))).toBeUndefined();
  });

  test("Bash -> undefined", () => {
    expect(resolveSecretReadPath(check("Bash", { command: "cat .env" }))).toBeUndefined();
  });

  test("Read .pem -> undefined", () => {
    expect(resolveSecretReadPath(check("Read", { file_path: "kunci.pem" }))).toBeUndefined();
  });
});

describe("redactEnvFileText: celah tersembunyi", () => {
  test("kredensial lama di komentar disamarkan", () => {
    const hasil = redactEnvFileText("# DB_PASSWORD=oldpass1234\n#DB_PASS=abcdefgh\n");
    expect(hasil).not.toContain("oldpass1234");
    expect(hasil).not.toContain("abcdefgh");
    expect(hasil).toContain("DB_PASSWORD=[disembunyikan");
  });

  test("nilai multi-baris (kunci PEM) tak bocor di baris lanjutan", () => {
    const teks = [
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw",
      "abcdefghijklmnopqrstuvwxyz0123456789",
      '-----END PRIVATE KEY-----"',
      "DB_HOST=staging.internal",
    ].join("\n");
    const hasil = redactEnvFileText(teks);
    expect(hasil).not.toContain("MIIEvQ");
    expect(hasil).not.toContain("abcdefghijkl");
    expect(hasil).toContain("PRIVATE_KEY=[disembunyikan:nilai]");
    // Baris setelah nilai multi-baris tetap diproses.
    expect(hasil).toContain("DB_HOST=staging.internal");
  });
});
