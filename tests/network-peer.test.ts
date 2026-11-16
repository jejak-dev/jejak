import { describe, expect, test } from "bun:test";
import { createThrottle } from "../src/server/auth/throttle";
import { socketAddress } from "../src/server/routes/auth";
import { PEER_HEADER } from "../src/server/network/network-fetch";

describe("alamat klien untuk throttle", () => {
  test("header peer dipakai bila ada", () => {
    const request = new Request("http://192.168.1.5:4747/api/auth/login", {
      headers: { [PEER_HEADER]: "192.168.1.9" },
    });
    const server = { requestIP: () => ({ address: "127.0.0.1" }) };
    expect(socketAddress(server, request)).toBe("192.168.1.9");
  });

  test("tanpa header peer: alamat socket dipakai seperti sebelumnya", () => {
    const request = new Request("http://127.0.0.1:3000/api/auth/login");
    const server = { requestIP: () => ({ address: "127.0.0.1" }) };
    expect(socketAddress(server, request)).toBe("127.0.0.1");
  });

  test("tanpa server dan tanpa header: tak diketahui", () => {
    const request = new Request("http://127.0.0.1:3000/api/auth/login");
    expect(socketAddress(null, request)).toBe("tidak-diketahui");
  });

  test("throttle berlaku terpisah per klien jaringan", () => {
    const throttle = createThrottle({ maxFailures: 2 });
    const first = "192.168.1.9";
    const second = "192.168.1.10";
    // Klien pertama gagal beberapa kali.
    throttle.fail(first);
    throttle.fail(first);
    // Klien kedua tak boleh ikut terblokir.
    expect(throttle.check(second).blocked).toBe(false);
    expect(throttle.check(first).blocked).toBe(true);
  });
});
