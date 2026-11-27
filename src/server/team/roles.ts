/**
 * Preset peran tim. Fungsi murni: hanya menambah mode bawaan dan templat brief
 * pada `team_spawn`. Mode preset hanya `plan`, sehingga selalu sama atau lebih
 * ketat dari mode induk mana pun dan tak pernah memicu `mode-lebih-longgar`.
 */

export type TeamSpawnMode = "plan" | "default" | "acceptEdits";

export interface RolePreset {
  name: string;
  /** Hanya `plan`: baca saja, aman untuk semua induk. */
  mode?: "plan";
  /** <= 500 karakter; ditempel di depan prompt pengguna. */
  briefPrefix: string;
  summary: string;
}

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    name: "peneliti",
    mode: "plan",
    briefPrefix:
      "Anda peneliti. Selidiki dan laporkan temuan beserta jalur berkas/baris. Jangan mengubah berkas. Akhiri dengan ringkasan <= 15 baris.",
    summary: "Menyelidiki dan melapor temuan dengan jalur berkas/baris; tidak mengubah berkas.",
  },
  {
    name: "pengulas",
    mode: "plan",
    briefPrefix:
      "Anda pengulas. Nilai perubahan/kode yang disebut brief. Laporkan temuan berurut tingkat keparahan dengan bukti. Jangan memperbaiki apa pun.",
    summary: "Menilai kode/perubahan dan melapor temuan berurut keparahan; tidak memperbaiki.",
  },
  {
    name: "pelaksana",
    briefPrefix:
      "Anda pelaksana. Kerjakan tugas sempit dalam cakupan brief, jalankan verifikasi yang disebut, dan jangan menyentuh berkas di luar cakupan. Akhiri dengan ringkasan perubahan dan hasil verifikasi.",
    summary: "Mengerjakan tugas sempit sesuai cakupan brief lalu menjalankan verifikasi.",
  },
];

/** Cocok tanpa peka huruf besar dan setelah `trim`; label bebas lain `undefined`. */
export function findRolePreset(role: string | undefined): RolePreset | undefined {
  if (role === undefined) return undefined;
  const value = role.trim().toLowerCase();
  if (value === "") return undefined;
  return ROLE_PRESETS.find((preset) => preset.name === value);
}

/**
 * Terapkan preset peran pada brief. Mode eksplisit menang; bila tidak ada,
 * mode preset dipakai (bisa `undefined` untuk `pelaksana`). Role tak dikenal
 * dikembalikan apa adanya.
 */
export function applyRolePreset(input: {
  role?: string;
  prompt: string;
  mode?: TeamSpawnMode;
}): { prompt: string; mode?: TeamSpawnMode } {
  const preset = findRolePreset(input.role);
  if (preset === undefined) {
    return input.mode === undefined
      ? { prompt: input.prompt }
      : { prompt: input.prompt, mode: input.mode };
  }
  const mode = input.mode ?? preset.mode;
  return {
    prompt: `${preset.briefPrefix}\n\nTugas:\n${input.prompt}`,
    ...(mode === undefined ? {} : { mode }),
  };
}
