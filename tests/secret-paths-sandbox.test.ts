import { expect, test } from "bun:test";
import { checkSecretAccess, SECRET_BLOCK_REASON } from "../src/server/security/secret-paths";

const CWD = "/proyek/uji";

function bash(command: string) {
  return checkSecretAccess(
    { toolName: "Bash", toolInput: { command }, cwd: CWD, home: "/rumah/uji" },
  );
}

test("Bash yang menyebut /api/sandbox diblokir", () => {
  for (const command of [
    "curl http://127.0.0.1:3000/api/sandbox",
    "curl -X PUT 'http://127.0.0.1:3000/api/sandbox' -d '{\"mode\":\"mati\"}'",
    "echo x | curl -d @- http://localhost:3000/api/sandbox",
  ]) {
    const verdict = bash(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.rule).toBe("sandbox-api");
    expect(verdict.reason).toBe(SECRET_BLOCK_REASON);
  }
});

test("aturan claude dan secret-allow tetap berlaku", () => {
  expect(bash("curl http://127.0.0.1:3000/api/claude/config").rule).toBe("claude-config-api");
  expect(bash("curl http://127.0.0.1:3000/api/sessions/s_1/secret-allow").rule).toBe(
    "secret-allow-api",
  );
});

test("perintah tanpa /api/sandbox tidak diblokir", () => {
  expect(bash("ls -la").blocked).toBe(false);
  expect(bash("curl http://127.0.0.1:3000/api/health").blocked).toBe(false);
  expect(bash("cat docs/sandbox.md").blocked).toBe(false);
});

test("Bash yang menyebut /api/questions diblokir", () => {
  const verdict = bash("curl -X POST http://127.0.0.1:3000/api/questions/abc/answer -d '{\"answer\":\"ya\"}'");
  expect(verdict.blocked).toBe(true);
  expect(verdict.rule).toBe("questions-api");
});
