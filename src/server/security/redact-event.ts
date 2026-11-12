/**
 * Penyamaran rahasia pada `AgentEvent`. Fungsi murni: objek masukan tidak
 * pernah dimutasi dan semua nilai string disalin.
 *
 * Kunci identitas (`type`, `id`, `toolUseId`, `parentToolUseId`, `sessionId`,
 * `expiresAt`, `decision`, `model`) tidak disentuh agar bentuk event tetap
 * dapat dipakai klien.
 */

import type { AgentEvent } from "../agent";
import { redactSecrets, type RedactHit } from "./redact";

const IDENTITY_KEYS = new Set([
  "type",
  "id",
  "toolUseId",
  "parentToolUseId",
  "sessionId",
  "expiresAt",
  "decision",
  "model",
  "anchorUuid",
]);

export interface RedactedEvent {
  event: AgentEvent;
  hits: RedactHit[];
}

interface HitAccumulator {
  order: string[];
  counts: Map<string, number>;
}

function addHits(acc: HitAccumulator, hits: RedactHit[]): void {
  for (const hit of hits) {
    if (hit.count <= 0) continue;
    const existing = acc.counts.get(hit.kind);
    if (existing === undefined) {
      acc.order.push(hit.kind);
      acc.counts.set(hit.kind, hit.count);
    } else {
      acc.counts.set(hit.kind, existing + hit.count);
    }
  }
}

function walk(
  value: unknown,
  extraValues: readonly string[],
  acc: HitAccumulator,
): unknown {
  if (typeof value === "string") {
    const result =
      extraValues.length === 0
        ? redactSecrets(value)
        : redactSecrets(value, { extraValues });
    addHits(acc, result.hits);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, extraValues, acc));
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      output[key] = IDENTITY_KEYS.has(key) ? item : walk(item, extraValues, acc);
    }
    return output;
  }
  return value;
}

export function redactEvent(
  event: AgentEvent,
  extraValues: readonly string[] = [],
): RedactedEvent {
  const acc: HitAccumulator = { order: [], counts: new Map() };
  const redacted = walk(event, extraValues, acc) as AgentEvent;
  const hits = acc.order.map((kind) => ({ kind, count: acc.counts.get(kind)! }));
  return { event: redacted, hits };
}
