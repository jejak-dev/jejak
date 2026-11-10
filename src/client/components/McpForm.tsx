import { useState } from "preact/hooks";
import type { McpServerItem } from "../lib/api";
import { MCP_NAME_PATTERN, parseKeyValueLines, type McpFormValues } from "../lib/mcp";

export interface McpFormProps {
  /** Ada saat mengubah server tersimpan; transport dikunci. */
  initial?: McpServerItem;
  busy: boolean;
  serverError?: string;
  onSubmit: (form: McpFormValues) => void;
  onCancel: () => void;
}

let formSeq = 0;

function validate(form: McpFormValues): string | undefined {
  if (!MCP_NAME_PATTERN.test(form.name.trim())) {
    return "Nama server harus [a-z0-9][a-z0-9_-]{0,31} (huruf kecil, angka, garis bawah, strip).";
  }
  if (form.transport === "stdio") {
    if (form.command.trim() === "") return "Command wajib diisi untuk server stdio.";
    const parsed = parseKeyValueLines(form.env, "env");
    if (parsed.errors.length > 0) return parsed.errors[0];
  } else {
    if (form.url.trim() === "") return "URL wajib diisi untuk server http.";
    const parsed = parseKeyValueLines(form.headers, "header");
    if (parsed.errors.length > 0) return parsed.errors[0];
  }
  return undefined;
}

export function McpForm({ initial, busy, serverError, onSubmit, onCancel }: McpFormProps) {
  const editing = initial !== undefined;
  const [id] = useState(() => {
    formSeq += 1;
    return `jk-mcp-form-${formSeq}`;
  });

  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [touched, setTouched] = useState({ command: false, url: false });
  const [headers, setHeaders] = useState("");
  const [removedEnvKeys, setRemovedEnvKeys] = useState<string[]>([]);
  const [removedHeaderNames, setRemovedHeaderNames] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | undefined>(undefined);

  const savedEnvKeys = (initial?.envKeys ?? []).filter((key) => !removedEnvKeys.includes(key));
  const savedHeaderNames = (initial?.headerNames ?? []).filter(
    (header) => !removedHeaderNames.includes(header),
  );

  const values: McpFormValues = {
    name,
    transport,
    command,
    args,
    env,
    url,
    headers,
    removedEnvKeys,
    removedHeaderNames,
  };

  const submit = (event: Event): void => {
    event.preventDefault();
    const message = validate(values);
    setLocalError(message);
    if (message !== undefined) return;
    onSubmit(values);
  };

  const error = localError ?? serverError;

  return (
    <form class="jk-mcp-form" onSubmit={submit} aria-busy={busy}>
      <div class="jk-field">
        <label class="jk-label" for={`${id}-name`}>
          Nama server
        </label>
        <input
          id={`${id}-name`}
          class="jk-input"
          type="text"
          value={name}
          maxLength={32}
          autoComplete="off"
          aria-invalid={name !== "" && !MCP_NAME_PATTERN.test(name.trim())}
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <div class="jk-field">
        <label class="jk-label" for={`${id}-transport`}>
          Transport
        </label>
        <select
          id={`${id}-transport`}
          class="jk-select"
          value={transport}
          disabled={editing || busy}
          onChange={(event) =>
            setTransport((event.currentTarget as HTMLSelectElement).value as "stdio" | "http")
          }
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
        {editing && <p class="jk-help">Transport tidak dapat diubah setelah dibuat.</p>}
      </div>

      {transport === "stdio" ? (
        <>
          <div class="jk-field">
            <label class="jk-label" for={`${id}-command`}>
              Command
            </label>
            <input
              id={`${id}-command`}
              class="jk-input"
              type="text"
              value={command}
              autoComplete="off"
              aria-invalid={touched.command && command.trim() === ""}
              onBlur={() => setTouched((value) => ({ ...value, command: true }))}
              onInput={(event) => setCommand((event.currentTarget as HTMLInputElement).value)}
            />
            <p class="jk-help">Dijalankan tanpa shell; spasi tidak diperbolehkan.</p>
          </div>

          <div class="jk-field">
            <label class="jk-label" for={`${id}-args`}>
              Args
            </label>
            <textarea
              id={`${id}-args`}
              class="jk-textarea"
              rows={3}
              value={args}
              placeholder="satu argumen per baris"
              onInput={(event) => setArgs((event.currentTarget as HTMLTextAreaElement).value)}
            />
          </div>

          <div class="jk-field">
            <span class="jk-label">Env</span>
            {savedEnvKeys.length > 0 && (
              <ul class="jk-mcp-keys" aria-label="Env tersimpan">
                {savedEnvKeys.map((key) => (
                  <li class="jk-mcp-key" key={key}>
                    <code>{key}</code>
                    <span class="jk-mcp-key-state">tersimpan</span>
                    <button
                      type="button"
                      class="jk-link-btn jk-mcp-danger"
                      disabled={busy}
                      aria-label={`Hapus env ${key}`}
                      onClick={() => setRemovedEnvKeys((current) => [...current, key])}
                    >
                      Hapus
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label class="jk-visually-hidden" for={`${id}-env`}>
              Env baru
            </label>
            <textarea
              id={`${id}-env`}
              class="jk-textarea"
              rows={3}
              value={env}
              placeholder="KUNCI=nilai, satu per baris"
              onInput={(event) => setEnv((event.currentTarget as HTMLTextAreaElement).value)}
            />
            <p class="jk-help">Hanya untuk menambah atau mengganti; nilai tersimpan tidak ditampilkan.</p>
          </div>
        </>
      ) : (
        <>
          <div class="jk-field">
            <label class="jk-label" for={`${id}-url`}>
              URL
            </label>
            <input
              id={`${id}-url`}
              class="jk-input"
              type="url"
              value={url}
              autoComplete="off"
              aria-invalid={touched.url && url.trim() === ""}
              onBlur={() => setTouched((value) => ({ ...value, url: true }))}
              onInput={(event) => setUrl((event.currentTarget as HTMLInputElement).value)}
            />
          </div>

          <div class="jk-field">
            <span class="jk-label">Header</span>
            {savedHeaderNames.length > 0 && (
              <ul class="jk-mcp-keys" aria-label="Header tersimpan">
                {savedHeaderNames.map((header) => (
                  <li class="jk-mcp-key" key={header}>
                    <code>{header}</code>
                    <span class="jk-mcp-key-state">tersimpan</span>
                    <button
                      type="button"
                      class="jk-link-btn jk-mcp-danger"
                      disabled={busy}
                      aria-label={`Hapus header ${header}`}
                      onClick={() =>
                        setRemovedHeaderNames((current) => [...current, header])
                      }
                    >
                      Hapus
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label class="jk-visually-hidden" for={`${id}-headers`}>
              Header baru
            </label>
            <textarea
              id={`${id}-headers`}
              class="jk-textarea"
              rows={3}
              value={headers}
              placeholder="Nama: nilai, satu per baris"
              onInput={(event) => setHeaders((event.currentTarget as HTMLTextAreaElement).value)}
            />
            <p class="jk-help">Hanya untuk menambah atau mengganti; nilai tersimpan tidak ditampilkan.</p>
          </div>
        </>
      )}

      {error !== undefined && (
        <p class="jk-error-line" role="alert">
          {error}
        </p>
      )}

      <div class="jk-form-actions">
        <button type="submit" class="jk-button jk-button-primary" disabled={busy}>
          {busy ? "Menyimpan…" : "Simpan"}
        </button>
        <button type="button" class="jk-button" disabled={busy} onClick={onCancel}>
          Batal
        </button>
      </div>
    </form>
  );
}
