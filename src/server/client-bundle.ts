import { join } from "node:path";

export interface ClientBundle {
  js: string;
  css: string;
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

export async function buildClientBundle(entry: string = DEFAULT_ENTRY): Promise<ClientBundle> {
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      minify: false,
      sourcemap: "none",
    });
  } catch (error) {
    throw new Error(`gagal membangun klien: ${summarizeError(error)}`);
  }

  if (!result.success) {
    throw new Error(`gagal membangun klien: ${summarizeLogs(result.logs)}`);
  }

  let js: string | undefined;
  let css = "";
  for (const output of result.outputs) {
    if (output.path.endsWith(".js")) {
      js = await output.text();
    } else if (output.path.endsWith(".css")) {
      css = await output.text();
    }
  }

  if (js === undefined) {
    throw new Error(
      `gagal membangun klien: tidak ada keluaran JavaScript (${summarizeLogs(result.logs)})`,
    );
  }

  return { js, css };
}
