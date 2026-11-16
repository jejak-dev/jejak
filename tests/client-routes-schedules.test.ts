import { describe, expect, test } from "bun:test";
import { parseHashRoute, schedulesHash } from "../src/client/lib/format";

describe("rute schedules", () => {
  test("hash dan parsing", () => {
    expect(schedulesHash()).toBe("#/schedules");
    expect(parseHashRoute(schedulesHash())).toEqual({ view: "schedules" });
    expect(parseHashRoute("#/schedules")).toEqual({ view: "schedules" });
    expect(parseHashRoute("#/schedules/")).toEqual({});
    expect(parseHashRoute("#/schedulesx")).toEqual({});
  });
});
