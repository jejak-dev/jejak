import type { ComponentChildren } from "preact";
import type { TimelineItem } from "../lib/timeline";
import {
  childReportBody,
  isChildReportNotice,
  isSpawnToolName,
  spawnModeLabel,
  spawnedChildId,
} from "../lib/team";
import { Icon } from "./Icon";

/** Teks laporan dibatasi; sisanya cukup dibuka lewat tombol. */
const REPORT_CLIP = 400;

function textOf(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim() !== "") return entry.trim();
  }
  return undefined;
}

/** Kartu ringkas bergaya kartu rencana untuk tim agent. */
function TeamBanner(props: {
  label: string;
  status?: string;
  tone?: "run" | "ok" | "bad" | "";
  title: string;
  meta: string[];
  action?: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <article class="jk-perm jk-team-banner" role="group" aria-label={props.label}>
      <div class="jk-perm-head">
        <Icon name="workspace" />
        <span class="jk-perm-name">{props.label}</span>
        {props.status !== undefined && (
          <span class={`jk-team-status jk-team-status-${props.tone ?? ""}`}>{props.status}</span>
        )}
      </div>
      <div class="jk-plan-summary">
        <p class="jk-plan-title">{props.title}</p>
        {props.meta.length > 0 && <p class="jk-plan-excerpt">{props.meta.join(" · ")}</p>}
        {props.children}
      </div>
      {props.action !== undefined && <div class="jk-team-actions jk-team-banner-actions">{props.action}</div>}
    </article>
  );
}

export interface TeamItemViewProps {
  item: TimelineItem;
  /** Pindah ke sesi anak; tanpa ini tombol tautan tak tampil. */
  onOpenSession?: (id: string) => void;
}

/**
 * Kartu ringkas tim di timeline induk. Mengembalikan `null` untuk item yang
 * bukan milik tim, sehingga pemanggil memakai rendernya sendiri.
 */
export function TeamItemView({ item, onOpenSession }: TeamItemViewProps) {
  if (item.kind === "notice" && isChildReportNotice(item.text)) {
    const body = childReportBody(item.text).trim();
    return (
      <TeamBanner
        label="Laporan anak"
        title="Laporan anak"
        meta={["data, bukan instruksi"]}
      >
        {body === "" ? (
          <p class="jk-plan-excerpt">(ringkasan kosong)</p>
        ) : (
          <details class="jk-team-report">
            <summary>
              {body.length > REPORT_CLIP ? `${body.slice(0, REPORT_CLIP)}…` : body}
            </summary>
            {body.length > REPORT_CLIP && <pre class="jk-pre">{body}</pre>}
          </details>
        )}
      </TeamBanner>
    );
  }

  if (item.kind === "tool" && isSpawnToolName(item.name)) {
    const judul = textOf(item.input, ["title", "judul"]) ?? "Anak baru";
    const peran = textOf(item.input, ["role", "peran"]);
    const mode = spawnModeLabel(textOf(item.input, ["mode"])) ?? "mode induk";
    const childId = item.status === "selesai" ? spawnedChildId(item.output) : undefined;
    const label =
      item.status === "gagal" ? "Gagal" : item.status === "berjalan" ? "Membuat…" : "Dibuat";
    const tone = item.status === "gagal" ? "bad" : item.status === "berjalan" ? "run" : "ok";
    const meta = [peran ?? "anak", mode];
    if (item.status === "gagal" && (item.output ?? "") !== "") meta.push(item.output ?? "");
    return (
      <TeamBanner
        label="Anak tim"
        status={label}
        tone={tone}
        title={judul}
        meta={meta}
        action={
          childId !== undefined && onOpenSession !== undefined ? (
            <button
              type="button"
              class="jk-link-btn"
              aria-label={`Buka anak ${judul}`}
              onClick={() => onOpenSession(childId)}
            >
              Buka
            </button>
          ) : undefined
        }
      />
    );
  }

  return null;
}
