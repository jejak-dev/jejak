import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { localGuard } from "../src/server/guard";

function makeApp(allowedHosts?: string[]) {
  return new Elysia()
    .use(localGuard(allowedHosts === undefined ? undefined : { allowedHosts }))
    .get("/api/x", () => ({ ok: true }))
    .post("/api/x", () => ({ ok: true }))
    .get("/", () => new Response("home"));
}

function apiRequest(method: string, headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:3000/api/x", {
    method,
    headers: { host: "127.0.0.1:3000", ...headers },
  });
}

describe("localGuard", () => {
  test("host valid lolos", async () => {
    const res = await makeApp().handle(apiRequest("GET", {}));
    expect(res.status).toBe(200);
  });

  test("host evil.test ditolak", async () => {
    const res = await makeApp().handle(apiRequest("GET", { host: "evil.test" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "host tidak diizinkan" });
  });

  test("origin sama lolos", async () => {
    const res = await makeApp().handle(
      apiRequest("GET", { host: "localhost:3000", origin: "http://localhost:3000" }),
    );
    expect(res.status).toBe(200);
  });

  test("origin lain ditolak", async () => {
    const res = await makeApp().handle(
      apiRequest("GET", { origin: "http://evil.test" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "origin tidak diizinkan" });
  });

  test("tanpa origin lolos", async () => {
    const res = await makeApp().handle(apiRequest("GET", {}));
    expect(res.status).toBe(200);
  });

  test("POST tanpa content-type json ditolak 415", async () => {
    const res = await makeApp().handle(apiRequest("POST", {}));
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "content-type harus application/json" });
  });

  test("POST dengan content-type json lolos", async () => {
    const res = await makeApp().handle(
      apiRequest("POST", { "content-type": "application/json" }),
    );
    expect(res.status).toBe(200);
  });

  test("GET / tidak kena guard", async () => {
    const res = await makeApp().handle(
      new Request("http://127.0.0.1:3000/", { headers: { host: "evil.test" } }),
    );
    expect(res.status).toBe(200);
  });

  test("allowedHosts kustom", async () => {
    const allowed = await makeApp(["jejak.test"]).handle(apiRequest("GET", { host: "jejak.test" }));
    expect(allowed.status).toBe(200);

    const rejected = await makeApp(["jejak.test"]).handle(apiRequest("GET", { host: "127.0.0.1:3000" }));
    expect(rejected.status).toBe(403);
  });
});
