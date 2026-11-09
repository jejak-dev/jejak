/**
 * Memuat nilai rahasia dari berkas `.env` di direktori sesi. Sinkron, tidak
 * pernah melempar, tidak mencatat log, dan tidak menyimpan cache global.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { collectEnvValues } from "./redact";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDED_SEGMENTS = new Set(["example", "sample", "template", "dist"]);

function isEnvFileName(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  const suffix = name.slice(".env".length);
  const segments = suffix.split(".").filter((segment) => segment !== "");
  return !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
}

function insideDirectory(target: string, root: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** Kumpulkan nilai dari `.env` / `.env.*` (kecuali contoh/templat) di `dir`. */
export function loadEnvValuesFromDir(dir: string): string[] {
  try {
    const root = resolve(dir);
    const entries = readdirSync(root).sort();
    const seen = new Set<string>();
    const values: string[] = [];
    let files = 0;

    for (const name of entries) {
      if (files >= MAX_FILES) break;
      if (!isEnvFileName(name)) continue;

      try {
        const path = join(root, name);
        const entry = lstatSync(path);
        let target = path;
        if (entry.isSymbolicLink()) {
          try {
            target = realpathSync(path);
          } catch {
            continue;
          }
          if (!insideDirectory(target, root)) continue;
        }
        const stats = target === path ? entry : statSync(target);
        if (!stats.isFile()) continue;
        if (stats.size > MAX_FILE_BYTES) continue;

        const text = readFileSync(target, "utf8");
        files += 1;
        for (const value of collectEnvValues(text)) {
          if (seen.has(value)) continue;
          seen.add(value);
          values.push(value);
        }
      } catch {
        continue;
      }
    }

    return values;
  } catch {
    return [];
  }
}
