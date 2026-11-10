import { expect, test } from "bun:test";
import { checkSecretAccess, SECRET_BLOCK_REASON } from "../src/server/security/secret-paths";

const CWD = "/proyek/uji";

function bash(command: string) {
  return checkSecretAccess(
    { toolName: "Bash", toolInput: { command }, cwd: CWD, home: "/rumah/uji" },
  );
}

test("Bash yang menyebut /api/claude diblokir", () => {
  for (const command of [
    "curl http://127.0.0.1:3000/api/claude/config",
    "curl -X PUT 'http://127.0.0.1:3000/api/claude/skills/project/pdf/enabled'",
    "echo x | curl -d @- http://localhost:3000/api/claude/instructions?scope=user",
  ]) {
    const verdict = bash(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.rule).toBe("claude-config-api");
    expect(verdict.reason).toBe(SECRET_BLOCK_REASON);
  }
});

test("aturan secret-allow tetap berlaku", () => {
  expect(bash("curl http://127.0.0.1:3000/api/sessions/s_1/secret-allow").rule).toBe(
    "secret-allow-api",
  );
});

test("perintah tanpa /api/claude tidak diblokir", () => {
  expect(bash("ls -la").blocked).toBe(false);
  expect(bash("curl http://127.0.0.1:3000/api/health").blocked).toBe(false);
  expect(bash("cat src/claude/README.md").blocked).toBe(false);
});
