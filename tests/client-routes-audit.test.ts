import { describe, expect, test } from "bun:test";
import { auditHash, parseHashRoute } from "../src/client/lib/format";

describe("rute log audit", () => {
  test("hash dan parsing", () => {
    expect(auditHash()).toBe("#/audit");
    expect(parseHashRoute(auditHash())).toEqual({ view: "audit" });
    expect(parseHashRoute("#/audit")).toEqual({ view: "audit" });
    expect(parseHashRoute("#/audit/")).toEqual({});
    expect(parseHashRoute("#/audits")).toEqual({});
  });
});
