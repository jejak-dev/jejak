import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../src/server/agent";
import { redactEvent } from "../src/server/security/redact-event";

describe("redactEvent", () => {
  test("menyamarkan string bersarang tanpa merusak bentuk event", () => {
    const event: AgentEvent = {
      type: "tool_call",
      id: "t1",
      name: "Bash",
      input: {
        command: "curl -H 'Authorization: Bearer abcdefgh12345678'",
        nested: [{ token: "ghp_abcdefgh12345678" }],
      },
      parentToolUseId: "p1",
    };
    const result = redactEvent(event);
    expect(JSON.stringify(result.event)).not.toContain("abcdefgh12345678");
    expect(result.event.type).toBe("tool_call");
    expect((result.event as { id: string }).id).toBe("t1");
    expect((result.event as { parentToolUseId?: string }).parentToolUseId).toBe("p1");
    expect(result.hits.map((hit) => hit.kind).sort()).toEqual(
      ["token Bearer", "token GitHub"].sort(),
    );
  });

  test("kunci identitas tidak disentuh walau isinya terlihat seperti rahasia", () => {
    const event: AgentEvent = {
      type: "session",
      sessionId: "ghp_abcdefgh12345678",
      model: "sk-abcdefgh12345678",
    };
    const result = redactEvent(event);
    expect(result.event).toEqual(event);
    expect(result.hits).toEqual([]);
  });

  test("objek masukan tidak dimutasi", () => {
    const event: AgentEvent = {
      type: "permission_request",
      id: "p",
      name: "Write",
      input: { file_path: "a.txt", content: "password = rahasia123" },
    };
    const snapshot = structuredClone(event);
    redactEvent(event);
    expect(event).toEqual(snapshot);
  });

  test("hits digabung per jenis dan jumlahnya dijumlahkan", () => {
    const event: AgentEvent = {
      type: "tool_result",
      id: "r1",
      isError: false,
      output: "sk-abcdefgh12345678 lalu sk-ijklmnop87654321 dan Bearer zyxwvuts65432100",
    };
    const result = redactEvent(event);
    expect(result.hits).toEqual([
      { kind: "kunci API", count: 2 },
      { kind: "token Bearer", count: 1 },
    ]);
  });

  test("tanpa rahasia menghasilkan objek setara", () => {
    const event: AgentEvent = { type: "text", text: "halo dunia bersih" };
    const result = redactEvent(event);
    expect(result.event).toEqual(event);
    expect(result.hits).toEqual([]);
  });

  test("nilai tambahan (mode .env) ikut disamarkan", () => {
    const event: AgentEvent = { type: "text", text: "nilai rahasia-env-1234 muncul" };
    const result = redactEvent(event, ["rahasia-env-1234"]);
    expect((result.event as { text: string }).text).not.toContain("rahasia-env-1234");
    expect(result.hits).toEqual([{ kind: "nilai .env", count: 1 }]);
  });

  test("teks notice disamarkan seperti text dan level tetap", () => {
    const event: AgentEvent = {
      type: "notice",
      level: "warn",
      text: "Anggaran habis untuk sk-abcdefgh12345678",
    };
    const result = redactEvent(event);
    expect((result.event as { text: string }).text).not.toContain("abcdefgh12345678");
    expect((result.event as { level: string }).level).toBe("warn");
    expect(result.hits).toEqual([{ kind: "kunci API", count: 1 }]);
  });
});
