/**
 * Daftar agent ACP yang dikenal Jejak. Jejak tidak menyimpan kredensial apa pun;
 * `installHint` dan `loginHint` hanya petunjuk untuk manusia.
 */
export interface AcpAgentDef {
  id: string;
  label: string;
  command: string[];
  installHint: string;
  loginHint: string;
}

export const ACP_AGENTS: Record<string, AcpAgentDef> = {
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    command: ["agy", "acp"],
    installHint:
      "Unduh agy_cli_<os>_<arch>.tar.gz dari github.com/google-antigravity/antigravity-cli/releases, lalu taruh `agy` di PATH",
    loginHint:
      "Jalankan `agy acp --login` sekali di terminal, atau atur API key Gemini",
  },
};

/** Id tak dikenal (termasuk nama bawaan prototipe) mengembalikan undefined. */
export function getAcpAgent(id: string): AcpAgentDef | undefined {
  if (!Object.hasOwn(ACP_AGENTS, id)) return undefined;
  return ACP_AGENTS[id];
}
