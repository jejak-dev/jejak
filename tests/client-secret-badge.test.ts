import { describe, expect, test } from "bun:test";
import { secretBadge } from "../src/client/lib/secret-badge";

describe("secretBadge", () => {
  test("undefined tanpa redactedEvents", () => {
    expect(secretBadge({})).toBeUndefined();
  });

  test("undefined saat nol", () => {
    expect(secretBadge({ redactedEvents: 0 })).toBeUndefined();
  });

  test("label dan title saat ada event tersamarkan", () => {
    const badge = secretBadge({ redactedEvents: 3 });
    expect(badge?.label).toBe("Rahasia disamarkan");
    expect(badge?.title).toBe(
      "3 event disamarkan di sesi ini. Lihat Audit log untuk rinciannya.",
    );
  });
});
