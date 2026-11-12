import { describe, expect, test } from "bun:test";
import { createThrottle } from "../src/server/auth/throttle";

describe("createThrottle", () => {
  test("sebelum gagal masih boleh mencoba", () => {
    const throttle = createThrottle();
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: false });
  });

  test("lima kegagalan beruntun menunda dua detik", () => {
    let now = 1_000;
    const throttle = createThrottle({ now: () => now });
    for (let index = 0; index < 5; index += 1) throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: true, retryAfterSec: 2 });
  });

  test("penundaan_escalasi berlipat ganda", () => {
    let now = 1_000;
    const throttle = createThrottle({ now: () => now });
    for (let index = 0; index < 6; index += 1) throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: true, retryAfterSec: 4 });
    throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: true, retryAfterSec: 8 });
  });

  test("penundaan dibatasi lima menit", () => {
    let now = 1_000;
    const throttle = createThrottle({ now: () => now });
    for (let index = 0; index < 20; index += 1) throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: true, retryAfterSec: 300 });
  });

  test("penundaan berakhir setelah waktu tunggu", () => {
    let now = 1_000;
    const throttle = createThrottle({ now: () => now });
    for (let index = 0; index < 5; index += 1) throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1").blocked).toBe(true);
    now += 2_000;
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: false });
  });

  test("berhasil mereset penghitung", () => {
    let now = 1_000;
    const throttle = createThrottle({ now: () => now });
    for (let index = 0; index < 4; index += 1) throttle.fail("127.0.0.1");
    throttle.succeed("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: false });
    throttle.fail("127.0.0.1");
    expect(throttle.check("127.0.0.1")).toEqual({ blocked: false });
  });

  test("dihitung per alamat socket", () => {
    const throttle = createThrottle();
    for (let index = 0; index < 5; index += 1) throttle.fail("10.0.0.1");
    expect(throttle.check("10.0.0.1").blocked).toBe(true);
    expect(throttle.check("10.0.0.2")).toEqual({ blocked: false });
  });
});
