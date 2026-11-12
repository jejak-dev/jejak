import { describe, expect, test } from "bun:test";
import type { ComponentChild, VNode } from "preact";
import { ApiError, createApiClient, type RunnerCommand } from "../src/client/lib/api";
import {
  confirmText,
  groupCommands,
  RUNNER_MAX_CUSTOM,
  runErrorMessage,
  validateCommandForm,
} from "../src/client/lib/runner";
import {
  RunnerView,
  type RunnerActions,
  type RunnerState,
} from "../src/client/components/RunnerTab";
import { parsePanelPrefs } from "../src/client/lib/panel-prefs";

/* ---------- Bantuan: telusuri pohon VNode tanpa DOM ---------- */

function textOf(node: ComponentChild): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const vnode = node as VNode;
  if (typeof vnode.type === "function") {
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
    const rendered = (vnode.type as (props: unknown) => ComponentChild)(vnode.props);
    return findNodes(rendered, predicate);
  }
  const self = predicate(vnode) ? [vnode] : [];
  return self.concat(findNodes(vnode.props.children as ComponentChild, predicate));
}

function byTag(node: ComponentChild, tag: string): VNode[] {
  return findNodes(node, (vnode) => vnode.type === tag);
}

function byClass(node: ComponentChild, className: string): VNode[] {
  return findNodes(node, (vnode) => {
    const value = (vnode.props as Record<string, unknown>).class;
    return typeof value === "string" && value.split(" ").includes(className);
  });
}

function propsOf(vnode: VNode | undefined): Record<string, unknown> {
  return (vnode?.props ?? {}) as Record<string, unknown>;
}

function buttonTexts(node: ComponentChild): string[] {
  return byTag(node, "button").map((vnode) => textOf(propsOf(vnode).children as ComponentChild));
}

/* ---------- Data bantu ---------- */

function pkg(overrides: Partial<RunnerCommand> = {}): RunnerCommand {
  return {
    id: "p_1",
    label: "test",
    command: "bun run test",
    source: "package",
    confirmed: false,
    detail: "bun test",
    ...overrides,
  };
}

function custom(overrides: Partial<RunnerCommand> = {}): RunnerCommand {
  return {
    id: "c_1",
    label: "Build",
    command: "bun run build",
    source: "custom",
    confirmed: true,
    ...overrides,
  };
}

const NOOP_ACTIONS: RunnerActions = {
  onRetry: () => undefined,
  onRun: () => undefined,
  onConfirmRun: () => undefined,
  onCancelConfirm: () => undefined,
  onEdit: () => undefined,
  onDelete: () => undefined,
  onConfirmDelete: () => undefined,
  onCancelDelete: () => undefined,
  onOpenForm: () => undefined,
  onFormChange: () => undefined,
  onSubmitForm: () => undefined,
  onCancelForm: () => undefined,
};

function stateOf(overrides: Partial<RunnerState> = {}): RunnerState {
  return {
    commands: [],
    loading: false,
    form: { open: false, mode: "tambah", label: "", command: "", group: "", saving: false },
    ...overrides,
  };
}

/* ---------- Fungsi murni ---------- */

describe("groupCommands", () => {
  test("script package lebih dulu, lalu grup kustom menurut urutan muncul", () => {
    const groups = groupCommands([
      custom({ id: "c_1", label: "Build", group: "Uji" }),
      pkg({ id: "p_1" }),
      custom({ id: "c_2", label: "Lint", group: "Uji" }),
      custom({ id: "c_3", label: "Deploy" }),
    ]);

    expect(groups.map((group) => group.title)).toEqual(["Package", "Uji", "Kustom"]);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(["p_1"]);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(["c_1", "c_2"]);
    expect(groups[2]?.items.map((item) => item.id)).toEqual(["c_3"]);
  });

  test("daftar kosong menghasilkan tanpa grup", () => {
    expect(groupCommands([])).toEqual([]);
  });

  test("grup kosong tidak muncul dan kustom tanpa grup diberi judul Kustom", () => {
    const groups = groupCommands([custom({ id: "c_1" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("Kustom");
  });
});

describe("validateCommandForm", () => {
  test("nilai sah mengembalikan label, command, dan grup yang sudah dipangkas", () => {
    const result = validateCommandForm({
      label: "  Jalankan tes  ",
      command: "  bun test  ",
      group: "  Uji  ",
    });
    expect(result).toEqual({
      ok: true,
      value: { label: "Jalankan tes", command: "bun test", group: "Uji" },
    });
  });

  test("grup kosong berarti tidak diisi", () => {
    const result = validateCommandForm({ label: "Tes", command: "bun test", group: "   " });
    expect(result).toEqual({ ok: true, value: { label: "Tes", command: "bun test" } });
  });

  test("label kosong ditolak", () => {
    const result = validateCommandForm({ label: "   ", command: "bun test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("label wajib diisi");
  });

  test("label lebih dari 60 karakter ditolak", () => {
    const result = validateCommandForm({ label: "a".repeat(61), command: "bun test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("60 karakter");
  });

  test("command kosong ditolak", () => {
    const result = validateCommandForm({ label: "Tes", command: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("command wajib diisi");
  });

  test("command lebih dari 500 karakter ditolak", () => {
    const result = validateCommandForm({ label: "Tes", command: "b".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500 karakter");
  });

  test("command dengan baris baru ditolak", () => {
    const result = validateCommandForm({ label: "Tes", command: "bun test\nbun lint" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("satu baris");
  });

  test("command dengan karakter kontrol ditolak", () => {
    const result = validateCommandForm({ label: "Tes", command: "bun test\tu" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("karakter kontrol");
  });

  test("label dengan karakter kontrol ditolak", () => {
    const result = validateCommandForm({ label: "Tes\nX", command: "bun test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("karakter kontrol");
  });

  test("grup lebih dari 40 karakter ditolak", () => {
    const result = validateCommandForm({ label: "Tes", command: "bun test", group: "g".repeat(41) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("40 karakter");
  });
});

describe("confirmText", () => {
  test("script package menampilkan isi script di samping perintahnya", () => {
    const text = confirmText(pkg({ command: "bun run test", detail: "bun test" }));
    expect(text).toContain("bun run test");
    expect(text).toContain("bun test");
    expect(text).toContain("Isi script:");
  });

  test("perintah kustom menampilkan perintah penuh", () => {
    const text = confirmText(custom({ command: "bun test && bun lint" }));
    expect(text).toContain("bun test && bun lint");
    expect(text).not.toContain("Isi script:");
  });
});

describe("runErrorMessage", () => {
  test("409 meminta konfirmasi ulang", () => {
    expect(runErrorMessage(409, "Perintah belum dikonfirmasi.")).toContain("konfirmasi");
  });

  test("503 menjelaskan cara menyalakan terminal", () => {
    expect(runErrorMessage(503, "Terminal dimatikan.")).toContain("JEJAK_TERMINAL=1");
  });

  test("429 menyebut batas terminal", () => {
    expect(runErrorMessage(429, "Batas terminal.")).toContain("Batas terminal");
  });

  test("404 meminta muat ulang daftar", () => {
    expect(runErrorMessage(404, "Folder tidak dikenal.")).toContain("tidak dikenal");
  });

  test("status lain memakai pesan server", () => {
    expect(runErrorMessage(400, "Permintaan tidak valid.")).toBe("Permintaan tidak valid.");
  });

  test("tanpa pesan memakai teks bawaan", () => {
    expect(runErrorMessage(0)).toBe("Perintah gagal dijalankan.");
  });
});

describe("batas perintah kustom", () => {
  test("batas 40 perintah kustom per folder", () => {
    expect(RUNNER_MAX_CUSTOM).toBe(40);
  });
});

/* ---------- Klien API ---------- */

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { fetch: impl as typeof fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api runner", () => {
  test("listRunner memakai GET dengan query cwd", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ commands: [pkg()] }));
    const api = createApiClient({ fetch });

    const result = await api.listRunner("/Users/proyek");

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.id).toBe("p_1");
    expect(calls[0]?.url).toBe("/api/runner?cwd=%2FUsers%2Fproyek");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  test("addRunnerCommand mengirim label, command, dan grup", async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse({ command: custom({ id: "c_9", label: "Build" }) }, 201),
    );
    const api = createApiClient({ fetch });

    const result = await api.addRunnerCommand("/p", {
      label: "Build",
      command: "bun run build",
      group: "Uji",
    });

    expect(result.id).toBe("c_9");
    expect(calls[0]?.url).toBe("/api/runner/custom");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ cwd: "/p", label: "Build", command: "bun run build", group: "Uji" }),
    );
  });

  test("addRunnerCommand tanpa grup tidak mengirim field group", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ command: custom() }, 201));
    const api = createApiClient({ fetch });

    await api.addRunnerCommand("/p", { label: "Build", command: "bun run build" });

    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ cwd: "/p", label: "Build", command: "bun run build" }),
    );
  });

  test("updateRunnerCommand memakai PATCH pada id ter-encode", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ command: custom({ id: "c_1" }) }));
    const api = createApiClient({ fetch });

    await api.updateRunnerCommand("/p", "c/1", { label: "Baru", group: "" });

    expect(calls[0]?.url).toBe("/api/runner/custom/c%2F1");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ cwd: "/p", label: "Baru", group: "" }),
    );
  });

  test("deleteRunnerCommand memakai DELETE dengan body kosong dan query cwd", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const api = createApiClient({ fetch });

    await api.deleteRunnerCommand("/p", "c_1");

    expect(calls[0]?.url).toBe("/api/runner/custom/c_1?cwd=%2Fp");
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.body).toBe("{}");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
  });

  test("runRunnerCommand mengirim cwd dan id tanpa confirm", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ terminalId: "t_1" }));
    const api = createApiClient({ fetch });

    const result = await api.runRunnerCommand("/p", "c_1");

    expect(result.terminalId).toBe("t_1");
    expect(calls[0]?.url).toBe("/api/runner/run");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ cwd: "/p", id: "c_1" }));
  });

  test("runRunnerCommand mengirim confirm true saat konfirmasi", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ terminalId: "t_1" }));
    const api = createApiClient({ fetch });

    await api.runRunnerCommand("/p", "c_1", true);

    expect(calls[0]?.init.body).toBe(
      JSON.stringify({ cwd: "/p", id: "c_1", confirm: true }),
    );
  });

  test("galat server menjadi ApiError", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: "Perintah belum dikonfirmasi." }, 409),
    );
    const api = createApiClient({ fetch });

    await expect(api.runRunnerCommand("/p", "c_1")).rejects.toBeInstanceOf(ApiError);
  });
});

/* ---------- Tampilan tab Commands ---------- */

describe("RunnerView", () => {
  test("daftar kosong menampilkan pesan dan tombol tambah", () => {
    const node = RunnerView({
      state: stateOf(),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Belum ada perintah.");
    expect(buttonTexts(node)).toContain("Tambah perintah");
  });

  test("galat memuat menampilkan tombol coba lagi", () => {
    const node = RunnerView({
      state: stateOf({ error: "Folder tidak dikenal." }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    expect(textOf(node)).toContain("Folder tidak dikenal.");
    expect(buttonTexts(node)).toContain("Coba lagi");
  });

  test("daftar berkelompok: Package, grup kustom, dan Kustom", () => {
    const node = RunnerView({
      state: stateOf({
        commands: [
          pkg({ id: "p_1", label: "test" }),
          custom({ id: "c_1", label: "Build", group: "Uji" }),
          custom({ id: "c_2", label: "Deploy" }),
        ],
      }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    const titles = byClass(node, "jk-runner-group-title").map((vnode) =>
      textOf(propsOf(vnode).children as ComponentChild),
    );
    expect(titles).toEqual(["Package", "Uji", "Kustom"]);
    expect(textOf(node)).toContain("test");
    expect(textOf(node)).toContain("Build");
    expect(textOf(node)).toContain("Deploy");
  });

  test("perintah belum terkonfirmasi menampilkan konfirmasi berisi isi script", () => {
    const node = RunnerView({
      state: stateOf({
        commands: [pkg({ id: "p_1", label: "test", command: "bun run test", detail: "bun test" })],
        confirmId: "p_1",
      }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    const confirm = byClass(node, "jk-runner-confirm");
    expect(confirm).toHaveLength(1);
    const text = textOf(confirm[0]);
    expect(text).toContain("bun run test");
    expect(text).toContain("bun test");
    expect(text).toContain("Isi script:");
    expect(buttonTexts(confirm[0])).toEqual(["Jalankan", "Batal"]);
  });

  test("perintah terkonfirmasi tidak menampilkan konfirmasi", () => {
    const node = RunnerView({
      state: stateOf({
        commands: [pkg({ id: "p_1", confirmed: true })],
      }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    expect(byClass(node, "jk-runner-confirm")).toHaveLength(0);
    expect(buttonTexts(node)).not.toContain("Jalankan");
  });

  test("tombol jalankan punya label aksesibel dengan nama perintah", () => {
    const node = RunnerView({
      state: stateOf({ commands: [pkg({ id: "p_1", label: "typecheck" })] }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    const labels = byTag(node, "button").map((vnode) => propsOf(vnode)["aria-label"]);
    expect(labels).toContain("Jalankan typecheck");
  });

  test("perintah kustom punya tombol ubah dan hapus, package tidak", () => {
    const node = RunnerView({
      state: stateOf({
        commands: [pkg({ id: "p_1", label: "test" }), custom({ id: "c_1", label: "Build" })],
      }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    const labels = byTag(node, "button").map((vnode) => propsOf(vnode)["aria-label"]);
    expect(labels).toContain("Ubah Build");
    expect(labels).toContain("Hapus Build");
    expect(labels).not.toContain("Ubah test");
  });

  test("hapus menampilkan konfirmasi inline", () => {
    const node = RunnerView({
      state: stateOf({
        commands: [custom({ id: "c_1", label: "Build" })],
        deletingId: "c_1",
      }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    const text = textOf(byClass(node, "jk-runner-confirm")[0]);
    expect(text).toContain("Hapus perintah");
    expect(text).toContain("Build");
  });

  test("batas 40 perintah kustom menyembunyikan tombol tambah", () => {
    const commands: RunnerCommand[] = [];
    for (let index = 0; index < RUNNER_MAX_CUSTOM; index += 1) {
      commands.push(custom({ id: `c_${index}`, label: `P${index}` }));
    }
    const node = RunnerView({
      state: stateOf({ commands }),
      actions: NOOP_ACTIONS,
    }) as unknown as ComponentChild;

    expect(buttonTexts(node)).not.toContain("Tambah perintah");
  });
});

/* ---------- Preferensi panel ---------- */

describe("panel-prefs", () => {
  test("tab Commands dikenali", () => {
    expect(parsePanelPrefs(JSON.stringify({ open: true, tab: "commands" }))).toEqual({
      open: true,
      tab: "commands",
    });
  });

  test("tab asing jatuh ke bawaan", () => {
    expect(parsePanelPrefs(JSON.stringify({ open: true, tab: "entah" }))).toEqual({
      open: true,
      tab: "changes",
    });
  });
});
