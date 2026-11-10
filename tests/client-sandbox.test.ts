import { describe, expect, test } from "bun:test";
import type { SandboxConfigItem, SandboxState } from "../src/client/lib/api";
import {
  canSubmit,
  listToText,
  parseListInput,
  sandboxBadge,
  sandboxPatchFrom,
  sandboxStatusLine,
} from "../src/client/lib/sandbox";

const CONFIG: SandboxConfigItem = {
  mode: "standar",
  allowedDomains: ["example.com"],
  extraDenyRead: ["~/.config/rahasia"],
  extraDenyWrite: ["/etc"],
};

function state(overrides: Partial<SandboxState> = {}): SandboxState {
  return {
    config: CONFIG,
    defaults: { allowedDomains: [], denyRead: [], denyWrite: [] },
    available: { ok: true, detail: "sandbox-exec tersedia" },
    ...overrides,
  };
}

describe("sandboxBadge", () => {
  test("hanya sesi tanpa sandbox yang berlencana", () => {
    expect(sandboxBadge({})).toBeUndefined();
    expect(sandboxBadge({ sandbox: "standar" })).toBeUndefined();
  });

  test("sesi mati memakai nada warn dan menyebut Audit log", () => {
    const badge = sandboxBadge({ sandbox: "mati" });
    expect(badge?.label).toBe("Tanpa sandbox");
    expect(badge?.tone).toBe("warn");
    expect(badge?.title).toContain("Audit log");
  });
});

describe("parseListInput domain", () => {
  test("baris dan koma, trim, buang kosong, lowercase, unik", () => {
    expect(parseListInput("Example.com, a.test\n\n example.com ", "domain")).toEqual({
      values: ["example.com", "a.test"],
    });
  });

  test("wildcard diterima", () => {
    expect(parseListInput("*.example.com", "domain")).toEqual({ values: ["*.example.com"] });
  });

  test("domain tidak valid menyebut entri", () => {
    const result = parseListInput("example.com, https://a.test", "domain");
    expect(result.values).toBeUndefined();
    expect(result.error).toContain("https://a.test");
  });

  test("entri bermasalah dipotong 40 karakter", () => {
    const long = `${"a".repeat(50)}!`;
    const result = parseListInput(long, "domain");
    expect(result.error).toContain(`${long.slice(0, 40)}…`);
    expect(result.error).not.toContain(long);
  });

  test("batas 100 entri", () => {
    const many = Array.from({ length: 100 }, (_, index) => `d${index}.test`).join("\n");
    expect(parseListInput(many, "domain").values).toHaveLength(100);
    const tooMany = `${many}\nextra.test`;
    expect(parseListInput(tooMany, "domain").error).toBeDefined();
  });
});

describe("parseListInput path", () => {
  test("absolut dan ~/ diterima", () => {
    expect(parseListInput("/etc\n~/.ssh", "path")).toEqual({ values: ["/etc", "~/.ssh"] });
  });

  test("relatif, segmen .., dan karakter kontrol ditolak", () => {
    expect(parseListInput("etc/passwd", "path").error).toContain("absolut");
    expect(parseListInput("/etc/../x", "path").error).toContain("..");
    expect(parseListInput("/etc/\u0001", "path").error).toContain("kontrol");
  });

  test("kosong menghasilkan daftar kosong", () => {
    expect(parseListInput("  \n ", "path")).toEqual({ values: [] });
  });
});

describe("listToText", () => {
  test("satu nilai per baris", () => {
    expect(listToText(["a.com", "b.com"])).toBe("a.com\nb.com");
    expect(listToText([])).toBe("");
  });
});

describe("sandboxStatusLine", () => {
  test("standar tersedia", () => {
    expect(sandboxStatusLine(state())).toBe("Sandbox standar · sandbox-exec tersedia");
  });

  test("mati global", () => {
    expect(sandboxStatusLine(state({ config: { ...CONFIG, mode: "mati" } }))).toBe(
      "Sandbox mati secara global",
    );
  });

  test("belum tersedia menyertakan detail", () => {
    expect(
      sandboxStatusLine(state({ available: { ok: false, detail: "bwrap tidak ditemukan" } })),
    ).toBe("Sandbox belum tersedia di mesin ini: bwrap tidak ditemukan");
  });
});

describe("canSubmit", () => {
  test("patch berisi perubahan mengaktifkan tombol", () => {
    expect(canSubmit({ patch: { mode: "mati" } }, false)).toBe(true);
  });

  test("tanpa perubahan tombol nonaktif", () => {
    expect(canSubmit({ patch: {} }, false)).toBe(false);
    expect(canSubmit({ patch: undefined }, false)).toBe(false);
  });

  test("galat validasi mengaktifkan tombol agar galat tampil", () => {
    expect(canSubmit({ error: "Domain tidak valid" }, false)).toBe(true);
  });

  test("sedang menyimpan selalu nonaktif", () => {
    expect(canSubmit({ patch: { mode: "mati" } }, true)).toBe(false);
    expect(canSubmit({ error: "Domain tidak valid" }, true)).toBe(false);
  });
});

describe("sandboxPatchFrom", () => {
  const form = {
    mode: CONFIG.mode,
    domains: listToText(CONFIG.allowedDomains),
    denyRead: listToText(CONFIG.extraDenyRead),
    denyWrite: listToText(CONFIG.extraDenyWrite),
  };

  test("tanpa perubahan menghasilkan patch kosong", () => {
    expect(sandboxPatchFrom(form, CONFIG)).toEqual({ patch: {} });
  });

  test("urutan daftar yang sama tidak dianggap berubah", () => {
    expect(
      sandboxPatchFrom({ ...form, domains: "b.test\na.test" }, {
        ...CONFIG,
        allowedDomains: ["a.test", "b.test"],
      }),
    ).toEqual({ patch: {} });
  });

  test("hanya field yang berubah", () => {
    expect(
      sandboxPatchFrom(
        { ...form, mode: "mati", denyWrite: "/srv" },
        CONFIG,
      ),
    ).toEqual({ patch: { mode: "mati", extraDenyWrite: ["/srv"] } });
  });

  test("galat validasi diteruskan tanpa patch", () => {
    const result = sandboxPatchFrom({ ...form, domains: "https://x" }, CONFIG);
    expect(result.patch).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});
