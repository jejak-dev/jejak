import { describe, expect, test } from "bun:test";
import {
  checkSecretAccess,
  isSecretFilePath,
} from "../src/server/security/secret-paths";

/** Aturan yang cocok untuk sebuah path, atau undefined bila tak ada blokir. */
function rule(path: string, platform: NodeJS.Platform): string | undefined {
  const verdict = checkSecretAccess(
    {
      toolName: "Read",
      toolInput: { file_path: path },
      cwd: "/rumah/uji",
      home: "/rumah/uji",
    },
    { platform },
  );
  return verdict.blocked ? verdict.rule : undefined;
}

describe("isSecretFilePath di Windows", () => {
  test("menangkap berkas rahasia di path Windows", () => {
    expect(isSecretFilePath("C:\\Users\\x\\proj\\.env", "win32")).toBe(true);
    expect(isSecretFilePath("C:\\Users\\x\\.ssh\\id_rsa", "win32")).toBe(true);
    expect(isSecretFilePath("C:\\Users\\x\\.aws\\credentials", "win32")).toBe(true);
    // Huruf besar-kecil tak dibedakan di Windows.
    expect(isSecretFilePath(".ENV.local", "win32")).toBe(true);
  });

  test("meloloskan berkas biasa dan berkas contoh", () => {
    expect(isSecretFilePath("C:\\proj\\readme.md", "win32")).toBe(false);
    expect(isSecretFilePath(".env.example", "win32")).toBe(false);
  });

  test("SSH_EXEMPT: config dan known_hosts bukan rahasia", () => {
    // Aturan SSH_EXEMPT memakai nama persis "config" dan "known_hosts".
    expect(isSecretFilePath("C:\\Users\\x\\.SSH\\config", "win32")).toBe(false);
    expect(isSecretFilePath("C:\\Users\\x\\.ssh\\known_hosts", "win32")).toBe(false);
  });

  test("nama aturan sesuai kode", () => {
    expect(rule("C:\\Users\\x\\proj\\.env", "win32")).toBe(".env");
    expect(rule("C:\\Users\\x\\proj\\.ENV.local", "win32")).toBe(".env.*");
    expect(rule("C:\\Users\\x\\.ssh\\id_rsa", "win32")).toBe("id_rsa*");
    expect(rule("C:\\Users\\x\\.ssh\\identity", "win32")).toBe(".ssh/**");
    expect(rule("C:\\Users\\x\\.aws\\credentials", "win32")).toBe(".aws/credentials");
    expect(rule("C:\\proj\\readme.md", "win32")).toBeUndefined();
    expect(rule(".env.example", "win32")).toBeUndefined();
    expect(rule("C:\\Users\\x\\.SSH\\config", "win32")).toBeUndefined();
  });
});

describe("perilaku POSIX tak berubah", () => {
  test("path POSIX biasa tetap sama", () => {
    expect(isSecretFilePath("/Users/x/.ssh/id_rsa", "darwin")).toBe(true);
    expect(isSecretFilePath("/Users/x/.ssh/identity", "darwin")).toBe(true);
    expect(isSecretFilePath("/Users/x/.env", "darwin")).toBe(true);
    expect(isSecretFilePath("/Users/x/.env.local", "darwin")).toBe(true);
    expect(isSecretFilePath("/Users/x/.env.example", "darwin")).toBe(false);
    expect(isSecretFilePath("/Users/x/readme.md", "darwin")).toBe(false);
  });

  test("huruf besar-kecil tetap penting di POSIX (bandingkan Windows)", () => {
    // Di POSIX pencocokan segment .ssh peka huruf besar-kecil.
    expect(rule("/Users/x/.ssh/identity", "darwin")).toBe(".ssh/**");
    expect(rule("/Users/x/.SSH/identity", "darwin")).toBeUndefined();
    // Tapi aturan id_rsa* tetap berlaku apa pun huruf besarnya.
    expect(isSecretFilePath("/Users/x/.SSH/id_rsa", "darwin")).toBe(true);
    expect(rule("/Users/x/.SSH/id_rsa", "darwin")).toBe("id_rsa*");
  });
});
