import { VERSION } from "../shared/version";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function parseMajorMinor(v: string): [number, number] {
  const [major = "0", minor = "0"] = v.split(".");
  return [Number(major), Number(minor)];
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];

  const [major, minor] = parseMajorMinor(Bun.version);
  checks.push({
    name: "Bun >= 1.4",
    ok: major > 1 || (major === 1 && minor >= 4),
    detail: `terdeteksi ${Bun.version}`,
  });

  checks.push({
    name: "Git tersedia",
    ok: Bun.which("git") !== null,
    detail: Bun.which("git") ?? "tidak ditemukan di PATH",
  });

  checks.push({
    name: "Binding server",
    ok: true,
    detail: `${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3000}`,
  });

  console.log(`Jejak ${VERSION}\n`);
  for (const c of checks) {
    console.log(`${c.ok ? "OK  " : "GAGAL"}  ${c.name}  (${c.detail})`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
