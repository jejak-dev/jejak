import type { VNode } from "preact";
import { Select } from "../../src/client/components/Select";
import type { SelectOption } from "../../src/client/lib/select";

/**
 * VNode `Select` di pohon tanpa DOM.
 *
 * `Select` memakai hook Preact sehingga tak bisa dipanggil langsung saat
 * menelusuri pohon vnode (dipakai di berkas tes tanpa DOM); ia
 * diperlakukan sebagai daun dan diperiksa lewat props-nya.
 */
export function isSelectVNode(vnode: VNode): boolean {
  return vnode.type === Select;
}

/** Daftar opsi yang diberikan ke `Select`. */
export function selectOptions(vnode: VNode | undefined): SelectOption[] {
  const props = vnode?.props as Record<string, unknown> | undefined;
  const options = props?.["options"];
  return Array.isArray(options) ? (options as SelectOption[]) : [];
}
