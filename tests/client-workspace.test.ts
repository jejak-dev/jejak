import { describe, expect, test } from "bun:test";
import type { ServiceCardItem } from "../src/client/lib/api";
import {
  CARD_DESCRIPTION_MAX,
  CARD_ENTRY_MAX,
  CARD_LIST_MAX,
  KIND_OPTIONS,
  REPO_NAME_PATTERN,
  WORKSPACE_NAME_MAX,
  WORKSPACE_REPOS_MAX,
  cardSummary,
  defaultRepoPath,
  kindLabel,
  linesToList,
  listToLines,
  repoNameFromPath,
  sessionContextLabel,
  validateCardDraft,
  validateWorkspaceDraft,
  workspaceRepoOptions,
  checkpointRepoNote,
  effectivePanelRepo,
  panelRepoOptions,
  repoForRequest,
  type SessionRepo,
} from "../src/client/lib/workspace";

describe("kindLabel", () => {
  test("label Bahasa Indonesia tiap jenis", () => {
    expect(kindLabel("backend")).toBe("Backend");
    expect(kindLabel("frontend")).toBe("Frontend");
    expect(kindLabel("worker")).toBe("Worker");
    expect(kindLabel("library")).toBe("Library");
    expect(kindLabel("lainnya")).toBe("Lainnya");
  });

  test("KIND_OPTIONS lengkap dan urut", () => {
    expect(KIND_OPTIONS.map((option) => option.id)).toEqual([
      "backend",
      "frontend",
      "worker",
      "library",
      "lainnya",
    ]);
  });
});

describe("repoNameFromPath", () => {
  test("segmen terakhir huruf kecil", () => {
    expect(repoNameFromPath("/Users/boy/Developer/Jejak")).toBe("jejak");
    expect(repoNameFromPath("/Users/boy/Developer/jejak/")).toBe("jejak");
  });

  test("spasi, huruf besar, dan titik dinormalisasi", () => {
    expect(repoNameFromPath("/x/My Project")).toBe("my-project");
    expect(repoNameFromPath("/x/Artemis.Service")).toBe("artemis.service");
    expect(repoNameFromPath("/x/a b  c")).toBe("a-b--c");
  });

  test("karakter di luar pola menjadi strip dan dipangkas", () => {
    expect(repoNameFromPath("/x/(baru)!")).toBe("baru");
    expect(repoNameFromPath("/x/__wow__")).toBe("wow");
  });

  test("kosong atau hanya pemisah menjadi repo", () => {
    expect(repoNameFromPath("")).toBe("repo");
    expect(repoNameFromPath("/")).toBe("repo");
    expect(repoNameFromPath("/x/!!!")).toBe("repo");
  });

  test("hasil selalu sesuai pola dan maks 40", () => {
    for (const path of ["/x/Über Café", "/x/" + "a".repeat(80), "/x/.", "/x/Repo Satu Lagi"]) {
      const name = repoNameFromPath(path);
      expect(REPO_NAME_PATTERN.test(name)).toBe(true);
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("linesToList dan listToLines", () => {
  test("trim, buang kosong dan duplikat", () => {
    expect(linesToList(" a \n\n b \na\r\n  \nc")).toEqual(["a", "b", "c"]);
    expect(linesToList("")).toEqual([]);
  });

  test("bolak-balik", () => {
    expect(listToLines(["a", "b"])).toBe("a\nb");
    expect(linesToList(listToLines(["x", "y"]))).toEqual(["x", "y"]);
  });
});

describe("validateWorkspaceDraft", () => {
  const ok = { name: "Kantor", repos: [{ name: "api", path: "/tmp/api" }] };

  test("draft sah tidak menghasilkan galat", () => {
    expect(validateWorkspaceDraft(ok)).toBeUndefined();
    expect(validateWorkspaceDraft({ name: "K", repos: [] })).toBeUndefined();
  });

  test("nama wajib dan maksimal", () => {
    expect(validateWorkspaceDraft({ ...ok, name: "  " })).toContain("1-");
    expect(validateWorkspaceDraft({ ...ok, name: "a".repeat(WORKSPACE_NAME_MAX + 1) })).toContain(
      String(WORKSPACE_NAME_MAX),
    );
  });

  test("maksimal repo", () => {
    const repos = Array.from({ length: WORKSPACE_REPOS_MAX + 1 }, (_value, index) => ({
      name: `r${index}`,
      path: `/tmp/r${index}`,
    }));
    expect(validateWorkspaceDraft({ name: "x", repos })).toContain(String(WORKSPACE_REPOS_MAX));
  });

  test("nama repo sesuai pola dan unik", () => {
    expect(
      validateWorkspaceDraft({ name: "x", repos: [{ name: "Api", path: "/tmp/api" }] }),
    ).toContain("Nama repo");
    expect(
      validateWorkspaceDraft({ name: "x", repos: [{ name: "-api", path: "/tmp/api" }] }),
    ).toContain("Nama repo");
    expect(
      validateWorkspaceDraft({
        name: "x",
        repos: [
          { name: "api", path: "/tmp/api" },
          { name: "api", path: "/tmp/api2" },
        ],
      }),
    ).toContain("duplikat");
  });

  test("path wajib dan absolut", () => {
    expect(validateWorkspaceDraft({ name: "x", repos: [{ name: "api", path: "" }] })).toContain(
      "wajib",
    );
    expect(
      validateWorkspaceDraft({ name: "x", repos: [{ name: "api", path: "relatif/api" }] }),
    ).toContain("absolut");
  });
});

describe("validateCardDraft", () => {
  const ok = { description: "Layanan", tables: "a\nb", queues: "", calls: "" };

  test("draft sah", () => {
    expect(validateCardDraft(ok)).toBeUndefined();
  });

  test("deskripsi maksimal", () => {
    expect(validateCardDraft({ ...ok, description: "a".repeat(CARD_DESCRIPTION_MAX + 1) })).toContain(
      String(CARD_DESCRIPTION_MAX),
    );
  });

  test("maksimal entri per daftar", () => {
    const many = Array.from({ length: CARD_LIST_MAX + 1 }, (_value, index) => `e${index}`).join("\n");
    expect(validateCardDraft({ ...ok, tables: many })).toContain(String(CARD_LIST_MAX));
  });

  test("panjang tiap entri", () => {
    expect(validateCardDraft({ ...ok, queues: "a".repeat(CARD_ENTRY_MAX + 1) })).toContain(
      String(CARD_ENTRY_MAX),
    );
  });
});

describe("cardSummary", () => {
  const card = (overrides: Partial<ServiceCardItem> = {}): ServiceCardItem => ({
    description: "",
    kind: "lainnya",
    tables: [],
    queues: [],
    calls: [],
    updatedAt: null,
    ...overrides,
  });

  test("kartu kosong", () => {
    expect(cardSummary(card())).toBe("Belum diisi");
  });

  test("merangkum jenis dan daftar", () => {
    expect(cardSummary(card({ description: "Layanan", kind: "backend", tables: ["a", "b", "c"], queues: ["q"] }))).toBe(
      "Backend · 3 tabel · 1 queue",
    );
    expect(cardSummary(card({ kind: "frontend" }))).toBe("Frontend");
    expect(cardSummary(card({ calls: ["api"] }))).toBe("Lainnya · 1 panggilan");
  });
});

function workspace(
  repos: { name: string; path: string; missing: boolean }[],
): import("../src/client/lib/api").WorkspaceItem {
  const card: ServiceCardItem = {
    description: "",
    kind: "lainnya",
    tables: [],
    queues: [],
    calls: [],
    updatedAt: null,
  };
  return {
    id: "w1",
    name: "Kantor",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repos: repos.map((repo) => ({ ...repo, card })),
  };
}

describe("workspaceRepoOptions", () => {
  test("repo pertama primary, urutan dipertahankan, label missing", () => {
    const options = workspaceRepoOptions(
      workspace([
        { name: "api", path: "/repos/api", missing: false },
        { name: "web", path: "/repos/web", missing: true },
        { name: "worker", path: "/repos/worker", missing: false },
      ]),
    );
    expect(options).toEqual([
      { value: "/repos/api", label: "api", missing: false, primary: true },
      { value: "/repos/web", label: "web (hilang)", missing: true, primary: false },
      { value: "/repos/worker", label: "worker", missing: false, primary: false },
    ]);
  });

  test("workspace tanpa repo menghasilkan daftar kosong", () => {
    expect(workspaceRepoOptions(workspace([]))).toEqual([]);
  });
});

describe("defaultRepoPath", () => {
  test("mengembalikan path repo utama yang tidak missing", () => {
    expect(
      defaultRepoPath(
        workspace([
          { name: "api", path: "/repos/api", missing: false },
          { name: "web", path: "/repos/web", missing: false },
        ]),
      ),
    ).toBe("/repos/api");
  });

  test("undefined bila repo utama hilang atau daftar kosong", () => {
    expect(
      defaultRepoPath(workspace([{ name: "api", path: "/repos/api", missing: true }])),
    ).toBeUndefined();
    expect(defaultRepoPath(workspace([]))).toBeUndefined();
  });
});

describe("sessionContextLabel", () => {
  test("workspace dan folder terakhir cwd", () => {
    expect(sessionContextLabel({ workspaceName: "Kantor", cwd: "/x/api-service" })).toBe(
      "Kantor · api-service",
    );
  });

  test("tanpa workspace memakai shortPath cwd seperti biasa", () => {
    expect(sessionContextLabel({ cwd: "/x/api" })).toBe("/x/api");
    expect(sessionContextLabel({ cwd: "/x/" })).toBe("/x/");
    expect(sessionContextLabel({})).toBe("");
  });

  test("workspace tanpa cwd hanya nama workspace", () => {
    expect(sessionContextLabel({ workspaceName: "Kantor" })).toBe("Kantor");
  });
});

const SESSION_REPOS: SessionRepo[] = [
  { name: "api", primary: true, missing: false },
  { name: "web", primary: false, missing: false },
  { name: "lama", primary: false, missing: true },
];

describe("panelRepoOptions", () => {
  test("urutan tetap dan repo utama berlabel (utama)", () => {
    expect(panelRepoOptions(SESSION_REPOS)).toEqual([
      { value: "api", label: "api (utama)", missing: false },
      { value: "web", label: "web", missing: false },
      { value: "lama", label: "lama", missing: true },
    ]);
  });

  test("daftar kosong menghasilkan opsi kosong", () => {
    expect(panelRepoOptions([])).toEqual([]);
  });
});

describe("effectivePanelRepo", () => {
  test("pilihan yang masih ada dipakai apa adanya", () => {
    expect(effectivePanelRepo(SESSION_REPOS, "web")).toBe("web");
  });

  test("tanpa pilihan kembali ke repo utama", () => {
    expect(effectivePanelRepo(SESSION_REPOS, undefined)).toBe("api");
  });

  test("pilihan hilang atau tidak dikenal kembali ke repo utama", () => {
    expect(effectivePanelRepo(SESSION_REPOS, "lama")).toBe("api");
    expect(effectivePanelRepo(SESSION_REPOS, "tidak-ada")).toBe("api");
  });

  test("tanpa repo utama menghasilkan undefined", () => {
    expect(effectivePanelRepo([{ name: "web", primary: false, missing: false }], "web")).toBe(
      "web",
    );
    expect(effectivePanelRepo([{ name: "web", primary: false, missing: false }], undefined))
      .toBeUndefined();
    expect(effectivePanelRepo([], "api")).toBeUndefined();
  });
});

describe("repoForRequest", () => {
  test("undefined untuk repo utama agar permintaan identik dengan perilaku lama", () => {
    expect(repoForRequest(SESSION_REPOS, undefined)).toBeUndefined();
    expect(repoForRequest(SESSION_REPOS, "api")).toBeUndefined();
  });

  test("nama repo untuk pilihan non-utama, termasuk saat utama hilang", () => {
    expect(repoForRequest(SESSION_REPOS, "web")).toBe("web");
    expect(
      repoForRequest([{ name: "api", primary: true, missing: true }], undefined),
    ).toBeUndefined();
  });
});

describe("checkpointRepoNote", () => {
  test("catatan memuat nama repo utama untuk sesi ber-workspace", () => {
    expect(checkpointRepoNote(SESSION_REPOS)).toBe("Titik hanya untuk repo utama sesi (api).");
  });

  test("tanpa workspace tidak ada catatan", () => {
    expect(checkpointRepoNote(undefined)).toBeUndefined();
  });

  test("workspace tanpa repo utama tetap memberi catatan umum", () => {
    expect(checkpointRepoNote([{ name: "web", primary: false, missing: false }])).toBe(
      "Titik hanya untuk repo utama sesi.",
    );
  });
});
