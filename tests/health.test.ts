import { expect, test } from "bun:test";
import { createApp } from "../src/server";
import { VERSION } from "../src/shared/version";

test("GET /api/health mengembalikan status ok", async () => {
  const res = await createApp().handle(new Request("http://localhost/api/health"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, name: "jejak", version: VERSION });
});
