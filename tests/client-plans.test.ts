import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import {
  extractPlans,
  isResumablePermission,
  planExcerpt,
  planTitle,
  PLAN_EXCERPT_MAX,
  PLAN_TITLE_FALLBACK,
  resumablePlans,
  type PlanEntry,
} from "../src/client/lib/plans";
import type { PermissionStatus, TimelineItem } from "../src/client/lib/timeline";
import {
  PlanCardView,
  PlanDoneRow,
  type PlanDecisionState,
} from "../src/client/components/PlanCard";
import { PlanTabView } from "../src/client/components/PlanTab";
import { isSelectVNode, selectOptions } from "./helpers/select-vnode";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    // `Select` memakai hook, jadi tak bisa dipanggil langsung tanpa DOM.
    if (isSelectVNode(vnode)) return "";
    return textOf((vnode.type as (props: unknown) => ComponentChild)(vnode.props));
  }
  return textOf(vnode.props.children as ComponentChild);
}

function findNodes(node: ComponentChild, predicate: (vnode: VNode) => boolean): VNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((child) => findNodes(child, predicate));
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
    // `Select` memakai hook, jadi tak bisa dipanggil langsung tanpa DOM.
    if (isSelectVNode(vnode)) return predicate(vnode) ? [vnode] : [];
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = propsOf(vnode)["class"];
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function buttons(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => vnode.type === "button");
}

function buttonTexts(node: ComponentChild): string[] {
  return buttons(node).map((vnode) => textOf(vnode.props.children as ComponentChild));
}

function bySelect(node: ComponentChild): VNode[] {
  return findNodes(node, (vnode) => isSelectVNode(vnode));
}

/* ---------- Data uji ---------- */

const DOKUMEN = [
  "# Rencana Rilis",
  "",
  "Ringkasan satu.",
  "",
  "Ringkasan dua.",
  "",
  "Ringkasan tiga.",
  "",
  "Paragraf penutup yang tidak boleh tampil di kartu chat.",
].join("\n");

const DECISION: PlanDecisionState = {
  busy: false,
  reviseOpen: false,
  feedback: "",
  onFeedbackChange: (): void => undefined,
  onToggleRevise: (): void => undefined,
  onCancelRevise: (): void => undefined,
  onApprove: (): void => undefined,
  onSubmitRevise: (): void => undefined,
};

function permission(
  id: string,
  plan: string,
  status: PermissionStatus = "menunggu",
): TimelineItem {
  return { kind: "permission", id, name: "ExitPlanMode", input: { plan }, status };
}

function plan(
  id: string,
  markdown: string,
  status: PermissionStatus = "menunggu",
): PlanEntry {
  return { id, title: planTitle(markdown), plan: markdown, status };
}

/* ---------- Logika murni ---------- */

describe("planTitle", () => {
  test("mengambil heading pertama", () => {
    expect(planTitle("# Rencana Rilis\nisi")).toBe("Rencana Rilis");
    expect(planTitle("paragraf\n\n## Sub judul\nisi")).toBe("Sub judul");
    expect(planTitle("###   ")).toBe(PLAN_TITLE_FALLBACK);
  });

  test("tanpa judul memakai nama cadangan", () => {
    expect(planTitle("")).toBe(PLAN_TITLE_FALLBACK);
    expect(planTitle("cuma paragraf")).toBe(PLAN_TITLE_FALLBACK);
  });

  test("membersihkan penanda markdown di judul", () => {
    expect(planTitle("# **Rencana** `rilis`")).toBe("Rencana rilis");
  });
});

describe("planExcerpt", () => {
  test("membuang penanda markdown dan baris heading", () => {
    const kutipan = planExcerpt("# Judul\n\n**Tebal** dan `kode` serta [tautan](https://x.test)");
    expect(kutipan).toBe("Tebal dan kode serta tautan");
    expect(kutipan).not.toContain("#");
    expect(kutipan).not.toContain("**");
    expect(kutipan).not.toContain("`");
  });

  test("membuang penanda daftar dan kutipan blok", () => {
    expect(planExcerpt("- satu\n> dua")).toBe("satu\ndua");
  });

  test("maksimal tiga baris dan tidak melebihi batas panjang", () => {
    const kutipan = planExcerpt("satu\n\ndua\n\ntiga\n\nempat");
    expect(kutipan.split("\n")).toHaveLength(3);
    expect(kutipan).toBe("satu\ndua\ntiga");
    const panjang = planExcerpt("a".repeat(500), 40);
    expect(panjang.length).toBeLessThanOrEqual(40);
    expect(panjang.endsWith("…")).toBe(true);
  });

  test("batas bawaan 160 karakter", () => {
    expect(PLAN_EXCERPT_MAX).toBe(160);
    expect(planExcerpt("b".repeat(500)).length).toBeLessThanOrEqual(PLAN_EXCERPT_MAX);
  });

  test("dokumen kosong menghasilkan kutipan kosong", () => {
    expect(planExcerpt("")).toBe("");
    expect(planExcerpt("# Hanya judul")).toBe("");
  });
});

describe("extractPlans", () => {
  test("mengambil rencana dari izin ExitPlanMode", () => {
    const plans = extractPlans([
      { kind: "user", text: "mulai" },
      permission("p1", "# Rencana A\nisi"),
      permission("p2", "# Rencana B\nisi", "diizinkan"),
    ]);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toEqual({
      id: "p1",
      title: "Rencana A",
      plan: "# Rencana A\nisi",
      status: "menunggu",
    });
    expect(plans[1]?.status).toBe("diizinkan");
  });

  test("abaikan izin lain dan rencana tanpa isi", () => {
    const plans = extractPlans([
      { kind: "permission", id: "x", name: "Bash", input: { command: "ls" }, status: "menunggu" },
      permission("p3", "   "),
    ]);
    expect(plans).toEqual([]);
  });

  test("menyimpan alasan penolakan dan batas waktu", () => {
    const item: TimelineItem = {
      kind: "permission",
      id: "p4",
      name: "ExitPlanMode",
      input: { plan: "# Rencana D" },
      status: "ditolak",
      expiresAt: "2026-11-15T10:00:00.000Z",
      message: "perlu detail",
    };
    const plans = extractPlans([item]);
    expect(plans[0]?.expiresAt).toBe("2026-11-15T10:00:00.000Z");
    expect(plans[0]?.message).toBe("perlu detail");
  });
});

describe("rencana yang terputus", () => {
  test("rencana terputus tanpa pesan pengguna sesudahnya bisa dilanjutkan", () => {
    const items: TimelineItem[] = [
      { kind: "user", text: "rencanakan" },
      permission("p1", "# Rencana A\nisi", "terputus"),
    ];
    const plans = extractPlans(items);
    expect(plans[0]?.status).toBe("terputus");
    expect(plans[0]?.resumable).toBe(true);
    expect(resumablePlans(plans).map((entry) => entry.id)).toEqual(["p1"]);
    expect(isResumablePermission(items, "p1")).toBe(true);
  });

  test("rencana terputus yang usang tak bisa dilanjutkan", () => {
    const items: TimelineItem[] = [
      permission("p1", "# Rencana A\nisi", "terputus"),
      { kind: "user", text: "lanjut saja" },
    ];
    const plans = extractPlans(items);
    expect(plans[0]?.resumable).toBeUndefined();
    expect(resumablePlans(plans)).toEqual([]);
    expect(isResumablePermission(items, "p1")).toBe(false);
  });

  test("rencana yang bukan terputus tak ditandai dapat dilanjutkan", () => {
    const plans = extractPlans([permission("p1", "# Rencana A\nisi", "menunggu")]);
    expect(plans[0]?.resumable).toBeUndefined();
    expect(resumablePlans(plans)).toEqual([]);
  });
});

/* ---------- Tampilan ---------- */

describe("kartu ringkas rencana di chat", () => {
  test("tak memuat isi dokumen, hanya judul dan kutipan", () => {
    const kartu = PlanCardView({
      id: "p1",
      title: "Rencana Rilis",
      excerpt: planExcerpt(DOKUMEN),
      remaining: 90,
      ...DECISION,
    });
    const teks = textOf(kartu);
    expect(teks).toContain("Rencana Rilis");
    expect(teks).toContain("Ringkasan satu.");
    expect(teks).not.toContain("Paragraf penutup");
  });

  test("tombol Buka rencana tersedia dan memanggil callback", () => {
    let dipanggil = "";
    const kartu = PlanCardView({
      id: "p1",
      title: "Rencana Rilis",
      excerpt: "Ringkasan.",
      remaining: null,
      ...DECISION,
      onOpenPlan: (): void => {
        dipanggil = "p1";
      },
    });
    expect(buttonTexts(kartu)).toContain("Buka rencana");
    const tombol = buttons(kartu).find(
      (vnode) => textOf(vnode.props.children as ComponentChild) === "Buka rencana",
    );
    (propsOf(tombol)["onClick"] as () => void)();
    expect(dipanggil).toBe("p1");
  });

  test("kartu menunggu punya Approve plan dan Revisi", () => {
    const kartu = PlanCardView({
      id: "p1",
      title: "Rencana Rilis",
      excerpt: "Ringkasan.",
      remaining: 90,
      ...DECISION,
      onOpenPlan: (): void => undefined,
    });
    const label = buttonTexts(kartu);
    expect(label).toContain("Approve plan");
    expect(label).toContain("Revisi");
    expect(label).toContain("Buka rencana");
  });

  test("ringkasan selesai tak memuat isi dokumen", () => {
    const baris = PlanDoneRow({
      id: "p1",
      title: "Rencana Rilis",
      status: "diizinkan",
      onOpenPlan: (): void => undefined,
    });
    const teks = textOf(baris);
    expect(teks).toContain("Rencana: Rencana Rilis");
    expect(teks).toContain("Diizinkan");
    expect(teks).not.toContain("Paragraf penutup");
    expect(buttonTexts(baris)).toContain("Buka rencana");
    expect(byClass(baris, "jk-step")).toHaveLength(1);
  });

  test("ringkasan ditolak memuat alasan pengguna", () => {
    const baris = PlanDoneRow({
      id: "p1",
      title: "Rencana Rilis",
      status: "ditolak",
      message: "perlu detail",
    });
    const teks = textOf(baris);
    expect(teks).toContain("Ditolak");
    expect(teks).toContain("perlu detail");
  });

  test("kartu terputus yang dapat dilanjutkan tetap punya tombol dan catatan", () => {
    const kartu = PlanCardView({
      id: "p1",
      title: "Rencana Rilis",
      excerpt: "Ringkasan.",
      remaining: null,
      interrupted: true,
      ...DECISION,
    });
    const label = buttonTexts(kartu);
    expect(label).toContain("Approve plan");
    expect(label).toContain("Revisi");
    const teks = textOf(kartu);
    expect(teks).toContain("Sesi sempat terputus.");
    expect(teks).not.toContain("ditolak otomatis dalam");
  });

  test("kartu terputus tanpa catatan tak menampilkan catatan lanjutan", () => {
    const kartu = PlanCardView({
      id: "p1",
      title: "Rencana Rilis",
      excerpt: "Ringkasan.",
      remaining: null,
      ...DECISION,
    });
    expect(textOf(kartu)).not.toContain("Sesi sempat terputus.");
  });

  test("ringkasan terputus menampilkan lencana sesi terputus", () => {
    const baris = PlanDoneRow({
      id: "p1",
      title: "Rencana Rilis",
      status: "terputus",
    });
    expect(textOf(baris)).toContain("Sesi terputus");
    expect(buttonTexts(baris)).not.toContain("Approve plan");
  });
});

describe("tab Rencana", () => {
  test("kosong memuat pesan belum ada rencana", () => {
    const tab = PlanTabView({ plans: [], selectedId: undefined, remaining: null, ...DECISION });
    expect(textOf(tab)).toContain("Belum ada rencana di sesi ini.");
  });

  test("menampilkan dokumen lengkap dan judul", () => {
    const tab = PlanTabView({
      plans: [plan("p1", DOKUMEN)],
      selectedId: "p1",
      remaining: 90,
      ...DECISION,
    });
    const teks = textOf(tab);
    expect(teks).toContain("Rencana Rilis");
    expect(teks).toContain("Paragraf penutup");
  });

  test("rencana menunggu punya tombol keputusan dan hitung mundur", () => {
    const tab = PlanTabView({
      plans: [plan("p1", DOKUMEN)],
      selectedId: "p1",
      remaining: 90,
      ...DECISION,
    });
    const label = buttonTexts(tab);
    expect(label).toContain("Approve plan");
    expect(label).toContain("Revisi");
    expect(textOf(tab)).toContain("ditolak otomatis dalam 1:30");
  });

  test("rencana yang sudah diputuskan menampilkan lencana status", () => {
    const tab = PlanTabView({
      plans: [plan("p1", DOKUMEN, "diizinkan")],
      selectedId: "p1",
      remaining: null,
      ...DECISION,
    });
    expect(textOf(tab)).toContain("Diizinkan");
    expect(buttonTexts(tab)).not.toContain("Approve plan");
  });

  test("lebih dari satu rencana memunculkan pemilih", () => {
    const plans = [plan("p1", "# Rencana Lama\nisi lama"), plan("p2", "# Rencana Baru\nisi baru")];
    const dipilih: string[] = [];
    const tab = PlanTabView({
      plans,
      selectedId: "p2",
      remaining: null,
      onSelect: (id): void => {
        dipilih.push(id);
      },
      ...DECISION,
    });
    const pemilih = bySelect(tab)[0];
    expect(pemilih).toBeDefined();
    const opsi = selectOptions(pemilih);
    expect(opsi.map((option) => option.label)).toEqual([
      "#1 Rencana Lama",
      "#2 Rencana Baru",
    ]);
    (propsOf(pemilih)["onChange"] as (value: string) => void)("p1");
    expect(dipilih).toEqual(["p1"]);
  });

  test("tanpa pemilih bila hanya satu rencana", () => {
    const tab = PlanTabView({
      plans: [plan("p1", DOKUMEN)],
      selectedId: "p1",
      remaining: null,
      ...DECISION,
    });
    expect(bySelect(tab)).toHaveLength(0);
  });

  test("rencana terputus yang dapat dilanjutkan punya tombol tanpa hitung mundur", () => {
    const tab = PlanTabView({
      plans: [{ ...plan("p1", DOKUMEN, "terputus"), resumable: true }],
      selectedId: "p1",
      remaining: 90,
      ...DECISION,
    });
    const label = buttonTexts(tab);
    expect(label).toContain("Approve plan");
    expect(label).toContain("Revisi");
    expect(textOf(tab)).toContain("Sesi sempat terputus.");
    expect(textOf(tab)).not.toContain("ditolak otomatis dalam");
  });

  test("rencana terputus yang usang tak punya tombol", () => {
    const tab = PlanTabView({
      plans: [plan("p1", DOKUMEN, "terputus")],
      selectedId: "p1",
      remaining: null,
      ...DECISION,
    });
    expect(buttonTexts(tab)).not.toContain("Approve plan");
    expect(buttonTexts(tab)).not.toContain("Revisi");
    expect(textOf(tab)).toContain("Sesi terputus");
    expect(textOf(tab)).not.toContain("Sesi sempat terputus.");
  });
});
