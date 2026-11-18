import { describe, expect, test } from "bun:test";
import { createApiClient } from "../src/client/lib/api";
import { parsePanelPrefs } from "../src/client/lib/panel-prefs";

describe("ApiClient terminal dan panel", () => {
  test("metode dan jalur", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ id: "t1", cwd: "/p", cols: 100, rows: 28, createdAt: "x", exited: false }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const api = createApiClient({ fetch: fetchImpl });
    expect((await api.createTerminal("/p", { cols: 100, rows: 28 })).id).toBe("t1");
    await api.closeTerminal("t1");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/terminal",
      "DELETE /api/terminal/t1",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ cwd: "/p", cols: 100, rows: 28 });
  });

  test("panel-prefs menerima tab terminal", () => {
    expect(parsePanelPrefs(JSON.stringify({ open: true, tab: "terminal" })).tab).toBe("terminal");
  });
});
