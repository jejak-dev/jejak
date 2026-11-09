import type { AuditEntryInput, AuditStore } from "./audit-store";

/** Catat satu entri audit; tidak pernah melempar dan no-op tanpa store. */
export function recordAudit(
  store: AuditStore | undefined,
  entry: AuditEntryInput,
): void {
  if (store === undefined) return;
  try {
    store.append(entry);
  } catch {
    // Audit tidak boleh mengubah respons rute.
  }
}
