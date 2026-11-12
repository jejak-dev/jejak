import { basename, join } from "node:path";

export interface ClientBundleFile {
  body: string;
  contentType: string;
}

export interface ClientBundle {
  js: string;
  css: string;
  /**
   * Artefak hasil code-splitting selain entri utama (chunk JS, aset lain).
   * Kunci = nama berkas tanpa "./", mis. "chunk-wp0ggtf7.js".
   */
  files: Map<string, ClientBundleFile>;
}

const DEFAULT_ENTRY = join(import.meta.dir, "../client/main.tsx");

function messageOf(log: unknown): string | undefined {
  if (typeof log === "object" && log !== null) {
    const message = (log as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return message.trim();
    }
  }
  return undefined;
}

function summarizeLogs(logs: readonly unknown[]): string {
  const messages: string[] = [];
  for (const log of logs) {
    const message = messageOf(log);
    if (message !== undefined && !messages.includes(message)) {
      messages.push(message);
    }
  }
  return messages.length > 0 ? messages.join("; ") : "kesalahan tidak diketahui";
}

function summarizeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      return summarizeLogs(errors);
    }
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message.trim();
  }
  return String(error);
}

/** Tipe konten berdasarkan ekstensi berkas artefak. */
function contentTypeOf(name: string): string {
  if (name.endsWith(".js") || name.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (name.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  return "application/octet-stream";
}

export async function buildClientBundle(entry: string = DEFAULT_ENTRY): Promise<ClientBundle> {
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      // Code-splitting: import dinamis (mis. mermaid) jadi chunk terpisah
      // yang hanya diambil browser saat benar-benar dibutuhkan.
      splitting: true,
      minify: { whitespace: true, syntax: true, identifiers: false },
      sourcemap: "none",
      // Chunk mengimpor entri dengan nama relatif (mis. "./app.js"). Nama
      // keluaran harus sama dengan URL yang disajikan server (/app.js),
      // kalau tidak chunk tidak bisa dimuat browser.
      naming: { entry: "app.[ext]" },
    });
  } catch (error) {
    throw new Error(`gagal membangun klien: ${summarizeError(error)}`);
  }

  if (!result.success) {
    throw new Error(`gagal membangun klien: ${summarizeLogs(result.logs)}`);
  }

  let js: string | undefined;
  let css = "";
  const files = new Map<string, ClientBundleFile>();
  for (const output of result.outputs) {
    if (output.kind === "sourcemap" || output.kind === "bytecode") continue;
    const name = basename(output.path);
    if (output.kind === "entry-point" && output.path.endsWith(".js")) {
      if (js === undefined) js = await output.text();
      continue;
    }
    if (output.path.endsWith(".css") && (output.kind === "entry-point" || output.kind === "asset")) {
      if (css === "") css = await output.text();
      continue;
    }
    files.set(name, { body: await output.text(), contentType: contentTypeOf(name) });
  }

  if (js === undefined) {
    throw new Error(
      `gagal membangun klien: tidak ada keluaran JavaScript (${summarizeLogs(result.logs)})`,
    );
  }

  return { js, css, files };
}
