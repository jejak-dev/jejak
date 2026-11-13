import { describe, expect, test } from "bun:test";
import { ApiError, type SdkCheckResult, type SdkClaude, type SdkStatus } from "../src/client/lib/api";
import {
  CLAUDE_MISSING_HINT,
  SDK_CONSENT_TEXT,
  SDK_PACKAGE_NAME,
  SDK_REGISTRY_HOST,
  SDK_TERMS_URL,
  canRollback,
  claudeSourceLabel,
  claudeStatusFacts,
  claudeStatusLine,
  confirmationFacts,
  describeClaudeError,
  describeSdkError,
  formatSize,
  sdkInstallIntent,
  sdkStatusFacts,
  sdkStatusLine,
} from "../src/client/lib/sdk";

function claude(overrides: Partial<SdkClaude> = {}): SdkClaude {
  return {
    found: false,
    path: null,
    version: null,
    source: null,
    configuredPath: null,
    ...overrides,
  };
}

function status(overrides: Partial<SdkStatus> = {}): SdkStatus {
  return {
    installed: { version: "0.3.323", installedAt: "2026-11-12T10:00:00.000Z" },
    previous: null,
    supportedRange: ">=0.3.0 <1",
    lastCheck: null,
    busy: false,
    claude: claude(),
    ...overrides,
  };
}

function kandidat(overrides: Partial<SdkCheckResult> = {}): SdkCheckResult {
  return {
    latest: "0.3.323",
    candidate: "0.3.323",
    installedVersion: null,
    updateAvailable: false,
    ...overrides,
  };
}

describe("sdkStatusLine", () => {
  test("menyebut versi terpasang", () => {
    expect(sdkStatusLine(status())).toBe("Terpasang: 0.3.323");
  });

  test("belum terpasang", () => {
    expect(sdkStatusLine(status({ installed: null }))).toBe("Belum terpasang");
  });

  test("sedang memasang mengikuti server", () => {
    expect(sdkStatusLine(status({ busy: true }))).toContain("Sedang memasang");
  });
});

describe("sdkStatusFacts", () => {
  test("versi, tanggal, versi sebelumnya, dan rentang", () => {
    const facts = sdkStatusFacts(status({ previous: "0.3.322" }));
    expect(facts).toContain("Versi terpasang: 0.3.323");
    expect(facts).toContain("Tanggal pemasangan: 2026-11-12T10:00:00.000Z");
    expect(facts).toContain("Versi sebelumnya: 0.3.322");
    expect(facts).toContain("Rentang didukung: >=0.3.0 <1");
  });

  test("tanpa versi sebelumnya tidak disebut", () => {
    expect(sdkStatusFacts(status()).some((fact) => fact.includes("sebelumnya"))).toBe(false);
  });
});

describe("formatSize", () => {
  test("KB dan MB", () => {
    expect(formatSize(2048)).toBe("2,0 KB");
    expect(formatSize(5_200_000)).toBe("5,0 MB");
  });

  test("angka tidak diketahui ditulis plainly", () => {
    expect(formatSize(undefined)).toBe("tidak diketahui");
    expect(formatSize(-1)).toBe("tidak diketahui");
  });
});

describe("canRollback", () => {
  test("hanya ada bila ada versi sebelumnya", () => {
    expect(canRollback(status({ previous: "0.3.322" }))).toBe(true);
    expect(canRollback(status())).toBe(false);
    expect(canRollback(status({ previous: "" }))).toBe(false);
  });
});

describe("confirmationFacts", () => {
  test("sumber, paket, versi, dan perkiraan ukuran", () => {
    const facts = confirmationFacts(kandidat({ unpackedSize: 5_200_000 }));
    expect(facts).toContain(`Sumber: ${SDK_REGISTRY_HOST} (npm)`);
    expect(facts).toContain(`Paket: ${SDK_PACKAGE_NAME}`);
    expect(facts).toContain("Versi: 0.3.323");
    expect(facts).toContain("Perkiraan ukuran terpasang: ~5,0 MB");
  });

  test("catatan dari server ikut ditampilkan", () => {
    const facts = confirmationFacts(kandidat({ note: "Versi terbaru di luar rentang." }));
    expect(facts.some((fact) => fact.includes("di luar rentang"))).toBe(true);
  });

  test("ukuran tak diketahui tetap disebut", () => {
    const facts = confirmationFacts(kandidat());
    expect(facts.some((fact) => fact.includes("tidak diketahui"))).toBe(true);
  });
});

describe("sdkInstallIntent", () => {
  test("tanpa persetujuan tidak ada pemasangan", () => {
    expect(sdkInstallIntent(kandidat(), false)).toEqual({ kind: "tunggu" });
  });

  test("tanpa kandidat tidak ada pemasangan", () => {
    expect(sdkInstallIntent(undefined, true)).toEqual({ kind: "tunggu" });
  });

  test("setelah persetujuan memasang versi kandidat persis", () => {
    const intent = sdkInstallIntent(kandidat({ candidate: "0.3.322" }), true);
    expect(intent).toEqual({ kind: "pasang", version: "0.3.322" });
  });
});

describe("claudeStatusLine", () => {
  test("menyebut versi yang ditemukan", () => {
    expect(
      claudeStatusLine(
        claude({ found: true, path: "/usr/local/bin/claude", version: "2.1.0", source: "path" }),
      ),
    ).toBe("claude ditemukan: 2.1.0");
  });

  test("bilang tidak ditemukan", () => {
    expect(claudeStatusLine(claude())).toBe("claude tidak ditemukan");
  });
});

describe("claudeStatusFacts", () => {
  test("menyebut jalur dan sumbernya", () => {
    const facts = claudeStatusFacts(
      claude({ found: true, path: "/usr/local/bin/claude", version: "2.1.0", source: "setting" }),
    );
    expect(facts).toContain("Jalur: /usr/local/bin/claude");
    expect(facts).toContain("Sumber: pengaturan Jejak");
  });

  test("tanpa lokasi tidak ada fakta", () => {
    expect(claudeStatusFacts(claude())).toEqual([]);
  });
});

describe("claudeSourceLabel", () => {
  test("setiap sumber punya label Indonesia", () => {
    expect(claudeSourceLabel("env")).toBe("variabel JEJAK_CLAUDE_PATH");
    expect(claudeSourceLabel("setting")).toBe("pengaturan Jejak");
    expect(claudeSourceLabel("path")).toBe("PATH sistem");
    expect(claudeSourceLabel("common")).toBe("lokasi umum");
  });
});

describe("describeClaudeError", () => {
  test("400 meneruskan pesan server", () => {
    expect(describeClaudeError(new ApiError("Jalur harus absolut.", 400))).toBe(
      "Jalur harus absolut.",
    );
  });

  test("galat lain memakai pesan galat atau kalimat bawaan", () => {
    expect(describeClaudeError(new Error("rusak"))).toBe("rusak");
    expect(describeClaudeError(undefined)).toContain("kesalahan");
  });
});

describe("petunjuk CLI claude", () => {
  test("menyebut pemasangan resmi dan isi jalur manual", () => {
    expect(CLAUDE_MISSING_HINT).toContain("Claude Code");
    expect(CLAUDE_MISSING_HINT).toContain("jalur");
  });
});

describe("describeSdkError", () => {
  test("502 menyebut registry npm dan koneksi", () => {
    const pesan = describeSdkError(new ApiError("galat server", 502));
    expect(pesan).toContain("registry npm");
    expect(pesan).toContain("koneksi");
  });

  test("422 menyebut unduhan ditolak dan tidak ada yang dipasang", () => {
    const pesan = describeSdkError(new ApiError("integritas", 422)).toLowerCase();
    expect(pesan).toContain("ditolak");
    expect(pesan).toContain("tidak ada yang dipasang");
  });

  test("409 menyebut pemasangan sedang berjalan", () => {
    expect(describeSdkError(new ApiError("busy", 409))).toContain("sedang berjalan");
  });

  test("400 dan 404 meneruskan pesan server", () => {
    expect(describeSdkError(new ApiError("Versi di luar rentang.", 400))).toBe(
      "Versi di luar rentang.",
    );
    expect(describeSdkError(new ApiError("Tidak ada versi sebelumnya.", 404))).toBe(
      "Tidak ada versi sebelumnya.",
    );
  });

  test("galat lain memakai pesan galat atau kalimat bawaan", () => {
    expect(describeSdkError(new ApiError("", 500))).toContain("kesalahan");
    expect(describeSdkError(new Error("rusak"))).toBe("rusak");
    expect(describeSdkError(undefined)).toContain("kesalahan");
  });
});

describe("pernyataan persetujuan", () => {
  test("menyatakan kode dijalankan lokal dan tanpa skrip pemasangan", () => {
    expect(SDK_CONSENT_TEXT).toContain("dijalankan");
    expect(SDK_CONSENT_TEXT).toContain("npm install");
    expect(SDK_CONSENT_TEXT).toContain("Tidak ada skrip pemasangan");
  });

  test("tautan ketentuan Anthropic tetap dari sumber tetap", () => {
    expect(SDK_TERMS_URL).toBe("https://www.anthropic.com/legal/commercial-terms");
    expect(SDK_REGISTRY_HOST).toBe("registry.npmjs.org");
  });
});
