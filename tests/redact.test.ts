import { describe, expect, test } from "bun:test";
import { collectEnvValues, redactSecrets } from "../src/server/security/redact";

describe("redactSecrets: pola rahasia", () => {
  test("blok PEM penuh disamarkan, teks sekitar utuh", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAsecretmaterial",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = redactSecrets(`sebelum\n${pem}\nsesudah`);
    expect(result.text).not.toContain("secretmaterial");
    expect(result.text).not.toContain("BEGIN RSA");
    expect(result.text).toContain("[disembunyikan:kunci privat]");
    expect(result.text.startsWith("sebelum\n")).toBe(true);
    expect(result.text.endsWith("\nsesudah")).toBe(true);
    expect(result.hits).toEqual([{ kind: "kunci privat", count: 1 }]);
  });

  test("PEM tanpa END disamarkan sampai akhir teks", () => {
    const result = redactSecrets("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nabcdef");
    expect(result.text).toBe("x\n[disembunyikan:kunci privat]");
    expect(result.hits).toEqual([{ kind: "kunci privat", count: 1 }]);
  });

  test("URL berkredensial: hanya sandi yang diganti", () => {
    const result = redactSecrets("postgres://u:p4ssw0rd@db:5432/x");
    expect(result.text).toBe(
      "postgres://u:[disembunyikan:URL berkredensial]@db:5432/x",
    );
    expect(result.text).not.toContain("p4ssw0rd");
    expect(result.hits).toEqual([{ kind: "URL berkredensial", count: 1 }]);
  });

  test("token Bearer: kata Bearer tetap, nilainya disamarkan", () => {
    const result = redactSecrets("Authorization: Bearer abcdefghijklmnop1234");
    expect(result.text).toBe("Authorization: Bearer [disembunyikan:token Bearer]");
    expect(result.hits).toEqual([{ kind: "token Bearer", count: 1 }]);
  });

  test("kunci API sk- dan sk-ant-, hitungan beberapa kemunculan", () => {
    const result = redactSecrets("pakai sk-abcdefgh1234 dan sk-ant-zyxwvuts9876");
    expect(result.text).toBe(
      "pakai [disembunyikan:kunci API] dan [disembunyikan:kunci API]",
    );
    expect(result.hits).toEqual([{ kind: "kunci API", count: 2 }]);
  });

  test("token GitHub semua awalan", () => {
    const result = redactSecrets(
      "ghp_abcdefgh1234 gho_abcdefgh1234 ghs_abcdefgh1234 ghu_abcdefgh1234 github_pat_abcdefgh1234",
    );
    expect(result.text).toBe(
      "[disembunyikan:token GitHub] [disembunyikan:token GitHub] [disembunyikan:token GitHub] [disembunyikan:token GitHub] [disembunyikan:token GitHub]",
    );
    expect(result.hits).toEqual([{ kind: "token GitHub", count: 5 }]);
  });

  test("token GitLab", () => {
    const result = redactSecrets("nilai glpat-abcdefgh1234");
    expect(result.text).toBe("nilai [disembunyikan:token GitLab]");
    expect(result.hits).toEqual([{ kind: "token GitLab", count: 1 }]);
  });

  test("kunci AWS AKIA dan ASIA", () => {
    const result = redactSecrets("AKIAABCDEFGHIJKLMNOP dan ASIAABCDEFGHIJKLMNOP");
    expect(result.text).toBe(
      "[disembunyikan:kunci AWS] dan [disembunyikan:kunci AWS]",
    );
    expect(result.hits).toEqual([{ kind: "kunci AWS", count: 2 }]);
  });

  test("token Slack", () => {
    const result = redactSecrets("xoxb-1234567890-abcdefgh");
    expect(result.text).toBe("[disembunyikan:token Slack]");
    expect(result.hits).toEqual([{ kind: "token Slack", count: 1 }]);
  });
});

describe("redactSecrets: kredensial bernama", () => {
  const cases: Array<[string, string]> = [
    ["DB_PASSWORD=supersecret123", "DB_PASSWORD=[disembunyikan:kredensial]"],
    ["client_secret: supersecret123", "client_secret: [disembunyikan:kredensial]"],
    ['{"api_key":"supersecret123"}', '{"api_key":"[disembunyikan:kredensial]"}'],
    ["API_TOKEN='supersecret123'", "API_TOKEN='[disembunyikan:kredensial]'"],
    ['"client_secret": "supersecret123"', '"client_secret": "[disembunyikan:kredensial]"'],
    ['password: "hunter2hunter2"', 'password: "[disembunyikan:kredensial]"'],
  ];

  for (const [input, expected] of cases) {
    test(`menyamarkan nilai: ${input}`, () => {
      const result = redactSecrets(input);
      expect(result.text).toBe(expected);
      expect(result.text).not.toContain("supersecret123");
      expect(result.text).not.toContain("hunter2hunter2");
      expect(result.hits).toEqual([{ kind: "kredensial", count: 1 }]);
    });
  }

  test("beberapa kredensial dihitung semua, nama dan pemisah utuh", () => {
    const result = redactSecrets(
      "DB_PASSWORD=supersecret123 dan API_TOKEN=anothersecret456",
    );
    expect(result.text).toBe(
      "DB_PASSWORD=[disembunyikan:kredensial] dan API_TOKEN=[disembunyikan:kredensial]",
    );
    expect(result.hits).toEqual([{ kind: "kredensial", count: 2 }]);
  });

  test("placeholder jelas tidak disamarkan", () => {
    const text = [
      "DB_PASSWORD=changeme",
      "API_KEY=your-api-key-here",
      "PASSWORD=<secret>",
      "TOKEN=${TOKEN}",
      "SECRET=xxxxxxxx",
      "TOKEN=********",
      "API_KEY=example-value",
      "CLIENT_SECRET=dummy-value",
      "PASSWORD=placeholder123",
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.hits).toEqual([]);
  });
});

describe("redactSecrets: false positive aman", () => {
  test("hash git, path panjang, base64, UUID, dan kata prosa tidak disamarkan", () => {
    const text = [
      "commit a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
      "/var/lib/some/very/long/path/that/should/not/be/redacted/file.txt",
      "data:image/png;base64,QUJDREVGR0g=",
      "id 123e4567-e89b-12d3-a456-426614174000",
      "jangan menuliskan token di sini",
      "password sebaiknya disimpan di tempat aman",
    ].join("\n");
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.hits).toEqual([]);
  });
});

describe("redactSecrets: hits dan idempotensi", () => {
  test("hits tidak pernah memuat nilai asli", () => {
    const secrets = [
      "sk-abcdefgh1234",
      "ghp_abcdefgh1234",
      "supersecret123",
      "p4ssw0rd",
    ];
    const text = [
      "sk-abcdefgh1234",
      "ghp_abcdefgh1234",
      "DB_PASSWORD=supersecret123",
      "postgres://u:p4ssw0rd@db:5432/x",
    ].join("\n");
    const result = redactSecrets(text);
    const serialized = JSON.stringify(result.hits);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
    for (const hit of result.hits) {
      expect(Object.keys(hit).sort()).toEqual(["count", "kind"]);
    }
  });

  test("hits urut kemunculan pertama, bukan urutan pola", () => {
    const result = redactSecrets("sk-abcdefgh1234 lalu Bearer abcdefghijklmnop");
    expect(result.hits).toEqual([
      { kind: "kunci API", count: 1 },
      { kind: "token Bearer", count: 1 },
    ]);
  });

  test("idempoten", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "rahasia-pem",
      "-----END RSA PRIVATE KEY-----",
      "postgres://u:p4ssw0rd@db:5432/x",
      "Authorization: Bearer abcdefghijklmnop",
      "DB_PASSWORD=supersecret123",
      "sk-abcdefgh1234",
      "catatan envsecretvalue",
    ].join("\n");
    const once = redactSecrets(text, { extraValues: ["envsecretvalue"] });
    const twice = redactSecrets(once.text, { extraValues: ["envsecretvalue"] });
    expect(twice.text).toBe(once.text);
    expect(twice.hits).toEqual([]);
  });
});

describe("redactSecrets: extraValues", () => {
  test("nilai pendek, angka, dan boolean diabaikan", () => {
    const text = "abc 12345678 true false null";
    const result = redactSecrets(text, {
      extraValues: ["abc", "12345678", "true", "false", "null"],
    });
    expect(result.text).toBe(text);
    expect(result.hits).toEqual([]);
  });

  test("nilai yang memuat nilai lain: terpanjang lebih dulu", () => {
    const result = redactSecrets("supersecret123 dan supersecret", {
      extraValues: ["supersecret", "supersecret123"],
    });
    expect(result.text).toBe(
      "[disembunyikan:nilai .env] dan [disembunyikan:nilai .env]",
    );
    expect(result.hits).toEqual([{ kind: "nilai .env", count: 2 }]);
  });

  test("karakter regex khusus aman", () => {
    const result = redactSecrets("nilai a.b*c(d)[e] di sini", {
      extraValues: ["a.b*c(d)[e]"],
    });
    expect(result.text).toBe("nilai [disembunyikan:nilai .env] di sini");
    expect(result.hits).toEqual([{ kind: "nilai .env", count: 1 }]);
  });
});

describe("collectEnvValues", () => {
  test("mengurai petik, export, komentar, dan membuang nilai tak layak", () => {
    const env = [
      "# komentar",
      "",
      'export API_KEY="supersecretvalue"',
      "DB_PASSWORD='anothersecret'",
      "SHORT=abc",
      "NUM=12345678",
      "BOOL=true",
      "NOTHING=null",
      "EMPTY=",
      "PLACEHOLDER=changeme",
      "INLINE=realvalue123 # komentar",
      "DUP=realvalue123",
      'QUOTED_COMMENT="valuewithcomment" # x',
    ].join("\n");

    expect(collectEnvValues(env)).toEqual([
      "supersecretvalue",
      "anothersecret",
      "realvalue123",
      "valuewithcomment",
    ]);
  });

  test("masukan aneh tidak melempar", () => {
    expect(collectEnvValues("")).toEqual([]);
    expect(collectEnvValues("bukan assignment")).toEqual([]);
    expect(collectEnvValues("=nilai")).toEqual([]);
    expect(collectEnvValues("KEY")).toEqual([]);
    expect(collectEnvValues(undefined as unknown as string)).toEqual([]);
  });
});

describe("redactSecrets: kinerja", () => {
  test("2 MiB teks tanpa rahasia selesai < 1 detik", () => {
    const text = "a".repeat(2 * 1024 * 1024);
    const started = performance.now();
    const result = redactSecrets(text);
    const elapsed = performance.now() - started;
    expect(result.hits).toEqual([]);
    expect(result.text).toBe(text);
    expect(elapsed).toBeLessThan(1000);
  });

  test("2 MiB berisi 'aaaa...' selesai < 1 detik", () => {
    const text = "aaaa".repeat(512 * 1024);
    const started = performance.now();
    const result = redactSecrets(text);
    const elapsed = performance.now() - started;
    expect(result.hits).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
  });

  test("100000 baris 'password=abcdefgh1234' selesai < 1000 ms", () => {
    const text = Array.from(
      { length: 100000 },
      () => "password=abcdefgh1234",
    ).join("\n");
    const started = performance.now();
    const result = redactSecrets(text);
    const elapsed = performance.now() - started;
    expect(result.hits).toEqual([{ kind: "kredensial", count: 100000 }]);
    expect(result.text).not.toContain("abcdefgh1234");
    expect(elapsed).toBeLessThan(1000);
  });
});
