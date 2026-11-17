import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { localGuard } from "../src/server/guard";
import { isAllowedNetworkHost } from "../src/server/network/network-host";
import { VIA_HEADER, VIA_NETWORK } from "../src/server/network/network-fetch";

function makeApp(publicHost?: () => string | undefined) {
  return new Elysia()
    .use(
      localGuard({
        extraHostAllowed: (hostname, request) =>
          isAllowedNetworkHost(hostname, request, publicHost),
      }),
    )
    .get("/api/x", () => ({ ok: true }))
    .get("/", () => new Response("home"));
}

function apiRequest(
  host: string,
  headers: Record<string, string> = {},
  path = "/api/x",
): Request {
  return new Request(`http://${host}${path}`, {
    headers: { host, ...headers },
  });
}

const VIA = { [VIA_HEADER]: VIA_NETWORK };

describe("penjaga Host/Origin untuk listener jaringan", () => {
  test("IP privat dengan penanda jaringan lolos", async () => {
    const res = await makeApp().handle(apiRequest("192.168.1.5:4747", VIA));
    expect(res.status).toBe(200);
  });

  test("IP privat tanpa penanda jaringan ditolak", async () => {
    const res = await makeApp().handle(apiRequest("192.168.1.5:4747"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("IP publik dengan penanda jaringan ditolak", async () => {
    const res = await makeApp().handle(apiRequest("8.8.8.8:4747", VIA));
    expect(res.status).toBe(403);
  });

  test("nama bebas dengan penanda jaringan ditolak", async () => {
    const res = await makeApp().handle(apiRequest("evil.test:4747", VIA));
    expect(res.status).toBe(403);
  });

  test("nama .local dan .ts.net dengan penanda jaringan lolos", async () => {
    const lokal = await makeApp().handle(apiRequest("jejak.local:4747", VIA));
    expect(lokal.status).toBe(200);
    const tailscale = await makeApp().handle(apiRequest("mesin.tail.ts.net:4747", VIA));
    expect(tailscale.status).toBe(200);
  });

  test("host loopback tetap diizinkan seperti bawaan", async () => {
    const res = await makeApp().handle(apiRequest("127.0.0.1:3000"));
    expect(res.status).toBe(200);
  });

  test("origin tak cocok dengan host ditolak", async () => {
    const res = await makeApp().handle(
      apiRequest("192.168.1.5:4747", { ...VIA, origin: "http://evil.test" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin tidak diizinkan" });
  });

  test("origin sama dengan host lolos", async () => {
    const res = await makeApp().handle(
      apiRequest("192.168.1.5:4747", { ...VIA, origin: "http://192.168.1.5:4747" }),
    );
    expect(res.status).toBe(200);
  });

  test("halaman statis tak dijaga", async () => {
    const res = await makeApp().handle(
      apiRequest("192.168.1.5:4747", {}, "/"),
    );
    expect(res.status).toBe(200);
  });
});

describe("penjaga Host/Origin untuk host publik tunnel", () => {
  const publik = () => "jejak.contoh.com";

  test("host publik tersimpan dengan penanda jaringan lolos", async () => {
    const res = await makeApp(publik).handle(apiRequest("jejak.contoh.com", VIA));
    expect(res.status).toBe(200);
  });

  test("host publik lain ditolak", async () => {
    const res = await makeApp(publik).handle(apiRequest("lain.contoh.com", VIA));
    expect(res.status).toBe(403);
  });

  test("host publik tanpa penanda jaringan ditolak", async () => {
    const res = await makeApp(publik).handle(apiRequest("jejak.contoh.com"));
    expect(res.status).toBe(403);
  });

  test("origin https sama dengan host publik lolos", async () => {
    const res = await makeApp(publik).handle(
      apiRequest("jejak.contoh.com", { ...VIA, origin: "https://jejak.contoh.com" }),
    );
    expect(res.status).toBe(200);
  });

  test("origin lain ditolak", async () => {
    const res = await makeApp(publik).handle(
      apiRequest("jejak.contoh.com", { ...VIA, origin: "https://evil.test" }),
    );
    expect(res.status).toBe(403);
  });
});
