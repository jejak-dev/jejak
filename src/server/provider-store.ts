import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parseRegistry,
  registryFromEnv,
  serializeRegistry,
  validateRegistry,
  type ProviderRegistry,
} from "./provider";

export function jejakHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env.JEJAK_HOME?.trim();
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return join(homedir(), ".jejak");
}

export function providersPath(env: Record<string, string | undefined> = process.env): string {
  return join(jejakHome(env), "providers.json");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function loadRegistry(
  path: string = providersPath(),
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderRegistry> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return registryFromEnv(env);
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw new Error(`Berkas registry provider di "${path}" berisi JSON yang tidak valid.`);
  }

  const registry = parseRegistry(json, env);
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Registry provider di "${path}" tidak valid: ${errors.join(" ")}`);
  }
  return registry;
}

export async function saveRegistry(registry: ProviderRegistry, path?: string): Promise<void> {
  const target = path ?? providersPath();
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`Registry provider tidak valid: ${errors.join(" ")}`);
  }

  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const tempPath = `${target}.${process.pid}-${crypto.randomUUID()}.tmp`;
  const body = `${JSON.stringify(serializeRegistry(registry), null, 2)}\n`;

  try {
    await writeFile(tempPath, body, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, target);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Berkas sementara mungkin sudah tidak ada; error asli yang dilempar.
    }
    throw error;
  }

  await chmod(target, 0o600);
}
