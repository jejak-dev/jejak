import type { ClaudePluginItem } from "./api";

/**
 * Ringkasan komponen plugin satu baris: skill, perintah, agent, dan hooks.
 * Bagian yang nol tidak disebut; plugin tanpa apa-apa berarti "Tanpa komponen".
 */
export function pluginSummary(plugin: ClaudePluginItem): string {
  const bagian: string[] = [];
  if (plugin.skills > 0) bagian.push(`${plugin.skills} skill`);
  if (plugin.commands > 0) bagian.push(`${plugin.commands} perintah`);
  if (plugin.agents > 0) bagian.push(`${plugin.agents} agent`);
  if (plugin.hasHooks) bagian.push("hooks");
  return bagian.length === 0 ? "Tanpa komponen" : bagian.join(" · ");
}

/** Nama plugin dan versinya; versi kosong disembunyikan. */
export function pluginLabel(plugin: ClaudePluginItem): string {
  return plugin.version === "" ? plugin.name : `${plugin.name} ${plugin.version}`;
}

/** Plugin aktif didahulukan, lalu diurutkan menurut nama. */
export function sortPlugins(
  plugins: readonly ClaudePluginItem[],
): ClaudePluginItem[] {
  return [...plugins].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
