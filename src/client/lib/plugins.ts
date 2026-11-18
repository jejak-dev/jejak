import type { IconName } from "../components/Icon";
import type {
  ClaudePluginItem,
  MarketplacePluginItem,
  MarketplaceSourceKind,
} from "./api";

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

/** Nama sumber plugin dalam bahasa manusia. */
function sourceKindLabel(kind: MarketplaceSourceKind): string {
  switch (kind) {
    case "command":
      return "perintah marketplace";
    case "url":
      return "alamat URL";
    case "git":
      return "repositori git";
    case "marketplace":
      return "marketplace";
    default:
      return "sumber yang tak dikenal";
  }
}

/**
 * Peringatan singkat tentang asal kode plugin.
 *
 * Plugin `command` dipasang lewat perintah yang dideklarasikan marketplace,
 * jadi sumbernya perlu diperiksa pengguna sebelum dijalankan.
 */
export function marketplaceSourceNote(kind: MarketplaceSourceKind): string {
  switch (kind) {
    case "command":
      return "Plugin ini memasang lewat perintah yang dideklarasikan marketplace; periksa sumbernya sebelum memasang.";
    case "url":
    case "git":
      return "Kode diunduh dari repositori pihak ketiga.";
    case "marketplace":
      return "Berasal dari repositori marketplace.";
    default:
      return "Asal kode plugin tidak dikenal; periksa sumbernya sebelum memasang.";
  }
}

/**
 * Kalimat konfirmasi sebelum memasang plugin.
 *
 * Menyebut nama, marketplace, jenis sumber, dan akibatnya: kode pihak ketiga
 * diunduh dan plugin tidak dinyalakan otomatis.
 */
export function installConfirmText(plugin: MarketplacePluginItem): string {
  const nama = plugin.displayName !== "" ? plugin.displayName : plugin.name;
  return `Pasang ${nama} (${plugin.marketplace}) dari ${sourceKindLabel(plugin.sourceKind)}? Kode pihak ketiga akan diunduh. Plugin tidak dinyalakan otomatis setelah dipasang.`;
}

/** Label halaman hasil: mis. "1–50 dari 317". */
export function searchPageLabel(offset: number, limit: number, total: number): string {
  if (total <= 0) return "0 dari 0";
  const mulai = Math.min(Math.max(offset, 0) + 1, total);
  const selesai = Math.min(Math.max(offset, 0) + Math.max(limit, 0), total);
  return `${mulai}–${selesai} dari ${total}`;
}

/** Ikon avatar plugin menurut kategori; kategori tak dikenal memakai "plugin". */
export function pluginIconName(category: string): IconName {
  switch (category.trim().toLowerCase()) {
    case "development":
      return "code";
    case "productivity":
      return "checklist";
    case "database":
      return "database";
    case "monitoring":
      return "chart";
    case "security":
      return "shield";
    case "design":
      return "brush";
    case "deployment":
      return "rocket";
    case "automation":
      return "bolt";
    case "learning":
      return "book";
    case "testing":
      return "flask";
    case "location":
      return "pin";
    default:
      return "plugin";
  }
}

/** Warna avatar plugin (0..5), deterministik dari nama. */
export function pluginAvatarTone(nama: string): number {
  let hash = 0;
  for (const huruf of nama) {
    hash = (hash * 31 + huruf.codePointAt(0)!) >>> 0;
  }
  return hash % 6;
}
