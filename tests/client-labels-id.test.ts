import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function baca(relatif: string): string {
  return readFileSync(join(root, relatif), "utf8");
}

const sidebar = baca("src/client/components/Sidebar.tsx");
const commands = baca("src/client/lib/commands.ts");
const shortcuts = baca("src/client/lib/shortcuts.ts");
const composer = baca("src/client/components/Composer.tsx");

describe("label sidebar berbahasa Indonesia", () => {
  test("memuat nama halaman terjemahan", () => {
    for (const label of ["Instruksi", "Jadwal", "Pemakaian", "Log audit", "Notifikasi", "Sesi baru"]) {
      expect(sidebar).toContain(label);
    }
  });

  test("tidak lagi memuat label Inggris lama", () => {
    for (const label of [">Instructions<", ">Schedules<", ">Usage<", ">Audit log<", "Notifications"]) {
      expect(sidebar).not.toContain(label);
    }
  });
});

describe("palette perintah dan daftar pintasan", () => {
  test("keduanya memakai Sesi baru tanpa New session", () => {
    for (const sumber of [commands, shortcuts]) {
      expect(sumber).toContain("Sesi baru");
      expect(sumber).not.toContain("New session");
    }
  });
});

describe("label mode izin di komposer", () => {
  test("tidak lagi memakai label Inggris", () => {
    expect(composer).not.toContain("Ask permissions");
    expect(composer).not.toContain("Bypass permissions (dangerous)");
  });
});
