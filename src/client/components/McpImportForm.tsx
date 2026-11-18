import { useMemo, useState } from "preact/hooks";
import type { McpServerInput } from "../lib/api";
import { MCP_SUMMARY_MAX, parseMcpJson, type McpJsonEntry } from "../lib/mcp";

export interface McpImportFormProps {
  /** Nama server yang sudah terdaftar; baris dengan nama ini dilewati. */
  existingNames: readonly string[];
  busy: boolean;
  /** Galat per nama server dari percobaan kirim sebelumnya. */
  failures: Record<string, string | undefined>;
  onSubmit: (entries: McpJsonEntry[]) => void;
  onCancel: () => void;
}

let importSeq = 0;

const PLACEHOLDER = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "xxx" }
    }
  }
}`;

function summarizeInput(input: McpServerInput): string {
  if (input.transport === "http") return input.url ?? "";
  const parts = [input.command ?? "", ...(input.args ?? [])].filter((part) => part !== "");
  const text = parts.join(" ");
  return text.length > MCP_SUMMARY_MAX ? `${text.slice(0, MCP_SUMMARY_MAX)}…` : text;
}

export function McpImportForm({
  existingNames,
  busy,
  failures,
  onSubmit,
  onCancel,
}: McpImportFormProps) {
  const [id] = useState(() => {
    importSeq += 1;
    return `jk-mcp-import-${importSeq}`;
  });
  const [text, setText] = useState("");

  const parsed = useMemo(() => parseMcpJson(text), [text]);
  const existing = useMemo(() => new Set(existingNames), [existingNames]);

  const rows = parsed.entries.map((entry) => ({
    entry,
    duplicate: existing.has(entry.name),
  }));
  const sendable = rows.filter((row) => !row.duplicate).map((row) => row.entry);
  const empty = text.trim() === "";

  return (
    <form
      class="jk-mcp-form"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || sendable.length === 0) return;
        onSubmit(sendable);
      }}
    >
      <div class="jk-field">
        <label class="jk-label" for={`${id}-json`}>
          JSON konfigurasi MCP
        </label>
        <textarea
          id={`${id}-json`}
          class="jk-textarea jk-mcp-import-input"
          rows={10}
          value={text}
          placeholder={PLACEHOLDER}
          spellcheck={false}
          aria-label="JSON konfigurasi MCP"
          onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
        />
        <p class="jk-help">
          Tempel konfigurasi dari dokumentasi server MCP. Nilai rahasia hanya dikirim ke server
          Jejak dan tidak ditampilkan lagi.
        </p>
      </div>

      {!empty && rows.length > 0 && (
        <ul class="jk-mcp-import-list" aria-label="Server terbaca">
          {rows.map(({ entry, duplicate }) => (
            <li key={entry.name} class="jk-mcp-import-row">
              <span class="jk-mcp-import-name">{entry.name}</span>
              <span class="jk-mcp-transport">{entry.transport}</span>
              <span class="jk-mcp-summary">{summarizeInput(entry.input)}</span>
              {entry.secretKeys.length > 0 && (
                <span class="jk-mcp-import-secret">
                  {entry.secretKeys.length} kunci rahasia: {entry.secretKeys.join(", ")}
                </span>
              )}
              {duplicate && <span class="jk-mcp-import-skip">Sudah ada, dilewati</span>}
              {entry.warnings.map((warning) => (
                <span class="jk-mcp-import-warn" key={warning}>
                  {warning}
                </span>
              ))}
              {failures[entry.name] !== undefined && (
                <span class="jk-error-line" role="alert">
                  {failures[entry.name]}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {parsed.errors.length > 0 && (
        <div>
          {parsed.errors.map((error) => (
            <p class="jk-error-line" role="alert" key={error}>
              {error}
            </p>
          ))}
        </div>
      )}

      <div class="jk-form-actions">
        <button
          type="submit"
          class="jk-button jk-button-primary"
          disabled={busy || sendable.length === 0}
        >
          {busy ? "Menambahkan…" : `Tambahkan ${sendable.length} server`}
        </button>
        <button type="button" class="jk-button" disabled={busy} onClick={onCancel}>
          Batal
        </button>
      </div>
    </form>
  );
}
