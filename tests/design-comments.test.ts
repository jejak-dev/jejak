import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesignCommentError,
  addComment,
  deleteComment,
  listComments,
  updateComment,
} from "../src/server/design/comments";
import { designStamp } from "../src/server/design/manifest";
import { initDesign } from "../src/server/design/write";

let dir: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-design-comments-"));
  outside = await mkdtemp(join(tmpdir(), "jejak-design-comments-luar-"));
  await initDesign(dir, { tracked: true });
  await writeFile(join(dir, "design", "pages", "home.html"), "<html><body><p>Halo</p></body></html>", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function commentsPath(): string {
  return join(dir, "design", "comments.json");
}

function statusOf(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => 0,
    (error: unknown) => {
      expect(error).toBeInstanceOf(DesignCommentError);
      return (error as DesignCommentError).status;
    },
  );
}

function messageOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "",
    (error: unknown) => {
      expect(error).toBeInstanceOf(DesignCommentError);
      return (error as DesignCommentError).message;
    },
  );
}

async function noTempFiles(): Promise<void> {
  const names = await readdir(join(dir, "design"));
  expect(names.filter((name) => name.startsWith(".jejak-comments-") && name.endsWith(".tmp"))).toEqual([]);
}

const VALID = { slug: "home", selector: "#kartu", text: "Perbesar tombol ini" };

describe("listComments", () => {
  test("kosong tanpa folder design dan tanpa berkas", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-comments-kosong-"));
    try {
      expect(await listComments(kosong)).toEqual({ comments: [], mtime: 0 });
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
    expect(await listComments(dir)).toEqual({ comments: [], mtime: 0 });
  });

  test("tulis tanpa folder design -> 404 Desain belum dibuat.", async () => {
    const kosong = await mkdtemp(join(tmpdir(), "jejak-design-comments-kosong-"));
    try {
      expect(await statusOf(addComment(kosong, VALID))).toBe(404);
      expect(await messageOf(addComment(kosong, VALID))).toBe("Desain belum dibuat.");
      expect(await statusOf(updateComment(kosong, "c_0123456789", { status: "done" }))).toBe(404);
      expect(await statusOf(deleteComment(kosong, "c_0123456789"))).toBe(404);
    } finally {
      await rm(kosong, { recursive: true, force: true });
    }
  });
});

describe("addComment", () => {
  test("sukses: id berformat, status open, urutan di akhir", async () => {
    const first = await addComment(dir, VALID);
    expect(first.id).toMatch(/^c_[0-9a-f]{10}$/);
    expect(first.slug).toBe("home");
    expect(first.selector).toBe("#kartu");
    expect(first.text).toBe("Perbesar tombol ini");
    expect(first.status).toBe("open");
    expect(first.createdAt).toBeGreaterThan(0);

    const second = await addComment(dir, { ...VALID, selector: "#daftar" });
    const { comments } = await listComments(dir);
    expect(comments.map((comment) => comment.id)).toEqual([first.id, second.id]);
  });

  test("halaman tak ada 404, slug tak sah 400", async () => {
    expect(await statusOf(addComment(dir, { ...VALID, slug: "hilang" }))).toBe(404);
    expect(await messageOf(addComment(dir, { ...VALID, slug: "hilang" }))).toBe("Halaman tidak ditemukan.");
    expect(await statusOf(addComment(dir, { ...VALID, slug: "Bukan-Slug" }))).toBe(400);
  });

  test("halaman berupa symlink diperlakukan tak ada", async () => {
    await writeFile(join(outside, "target.html"), "<html></html>", "utf8");
    await symlink(join(outside, "target.html"), join(dir, "design", "pages", "tautan.html"));
    expect(await statusOf(addComment(dir, { ...VALID, slug: "tautan" }))).toBe(404);
  });

  test("selector dan text divalidasi", async () => {
    expect(await statusOf(addComment(dir, { ...VALID, selector: "" }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, selector: "   " }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, selector: "a\u0000b" }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, selector: "a\nb" }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, selector: "x".repeat(501) }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, text: "" }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, text: "   " }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, text: "x".repeat(1001) }))).toBe(400);
    expect(await statusOf(addComment(dir, { ...VALID, text: 12 }))).toBe(400);
    expect((await listComments(dir)).comments).toEqual([]);
  });

  test("field tak dikenal dan body bukan objek -> 400", async () => {
    expect(await statusOf(addComment(dir, { ...VALID, lain: true }))).toBe(400);
    expect(await statusOf(addComment(dir, "bukan objek"))).toBe(400);
    expect(await statusOf(addComment(dir, null))).toBe(400);
  });

  test("batas 200 komentar -> 409", async () => {
    const seed = Array.from({ length: 200 }, (_, index) => ({
      id: `c_${index.toString(16).padStart(10, "0")}`,
      slug: "home",
      selector: "#kartu",
      text: `komentar ${index}`,
      status: "open" as const,
      createdAt: 1,
    }));
    await writeFile(commentsPath(), JSON.stringify({ version: 1, comments: seed }), "utf8");
    expect(await statusOf(addComment(dir, VALID))).toBe(409);
    expect(await messageOf(addComment(dir, VALID))).toBe("Batas 200 komentar tercapai.");
  });
});

describe("updateComment", () => {
  test("status dan text diperbarui, teks di-trim", async () => {
    const created = await addComment(dir, VALID);
    const done = await updateComment(dir, created.id, { status: "done" });
    expect(done.status).toBe("done");
    expect(done.text).toBe("Perbesar tombol ini");
    const edited = await updateComment(dir, created.id, { text: "  Teks baru  " });
    expect(edited.text).toBe("Teks baru");
    expect(edited.status).toBe("done");
    expect(edited.createdAt).toBe(created.createdAt);
    expect((await listComments(dir)).comments[0]).toEqual(edited);
  });

  test("tanpa field, field tak dikenal, status salah -> 400", async () => {
    const created = await addComment(dir, VALID);
    expect(await statusOf(updateComment(dir, created.id, {}))).toBe(400);
    expect(await statusOf(updateComment(dir, created.id, { lain: 1 }))).toBe(400);
    expect(await statusOf(updateComment(dir, created.id, { status: "selesai" }))).toBe(400);
    expect(await statusOf(updateComment(dir, created.id, { text: "x".repeat(1001) }))).toBe(400);
  });

  test("id tak ada atau format salah -> 404", async () => {
    await addComment(dir, VALID);
    expect(await statusOf(updateComment(dir, "c_ffffffffff", { status: "done" }))).toBe(404);
    expect(await messageOf(updateComment(dir, "c_ffffffffff", { status: "done" }))).toBe(
      "Komentar tidak ditemukan.",
    );
    expect(await statusOf(updateComment(dir, "bukan-id", { status: "done" }))).toBe(404);
  });
});

describe("deleteComment", () => {
  test("sukses lalu 404", async () => {
    const created = await addComment(dir, VALID);
    await deleteComment(dir, created.id);
    expect((await listComments(dir)).comments).toEqual([]);
    expect(await statusOf(deleteComment(dir, created.id))).toBe(404);
    expect(await statusOf(deleteComment(dir, "c_0000000000"))).toBe(404);
  });
});

describe("berkas komentar", () => {
  test("JSON rusak -> 409", async () => {
    await writeFile(commentsPath(), "{rusak", "utf8");
    expect(await statusOf(listComments(dir))).toBe(409);
    expect(await messageOf(listComments(dir))).toBe("Berkas komentar rusak.");
    await writeFile(commentsPath(), JSON.stringify({ version: 2, comments: [] }), "utf8");
    expect(await statusOf(listComments(dir))).toBe(409);
    await writeFile(commentsPath(), JSON.stringify({ version: 1, comments: {} }), "utf8");
    expect(await statusOf(listComments(dir))).toBe(409);
  });

  test("entri bentuk salah disaring diam-diam", async () => {
    await writeFile(
      commentsPath(),
      JSON.stringify({
        version: 1,
        comments: [
          { id: "c_0123456789", slug: "home", selector: "#a", text: "ok", status: "open", createdAt: 1 },
          { id: "bukan-id", slug: "home", selector: "#b", text: "x", status: "open", createdAt: 2 },
          { id: "c_ffffffffff", slug: "home", selector: "#c", text: "x", status: "aneh", createdAt: 3 },
          "bukan objek",
        ],
      }),
      "utf8",
    );
    const { comments } = await listComments(dir);
    expect(comments.map((comment) => comment.id)).toEqual(["c_0123456789"]);
  });

  test("lebih dari 256 KB -> 413", async () => {
    await writeFile(commentsPath(), "x".repeat(256 * 1024 + 1), "utf8");
    expect(await statusOf(listComments(dir))).toBe(413);
    expect(await statusOf(addComment(dir, VALID))).toBe(413);
  });

  test("comments.json symlink -> 400", async () => {
    await writeFile(join(outside, "luar.json"), JSON.stringify({ version: 1, comments: [] }), "utf8");
    await symlink(join(outside, "luar.json"), commentsPath());
    expect(await statusOf(listComments(dir))).toBe(400);
    expect(await messageOf(listComments(dir))).toBe("Berkas komentar tidak valid.");
    expect(await statusOf(addComment(dir, VALID))).toBe(400);
    expect(await readFile(join(outside, "luar.json"), "utf8")).toBe(
      JSON.stringify({ version: 1, comments: [] }),
    );
  });

  test("tidak menyisakan berkas .tmp dan mode berkas dipertahankan", async () => {
    const created = await addComment(dir, VALID);
    await noTempFiles();
    await chmod(commentsPath(), 0o640);
    await updateComment(dir, created.id, { status: "done" });
    await noTempFiles();
    expect((await lstat(commentsPath())).mode & 0o777).toBe(0o640);
  });
});

describe("penulisan bersamaan", () => {
  test("20 addComment bersamaan menghasilkan 20 komentar unik", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        addComment(dir, { ...VALID, text: `komentar ${index}` }),
      ),
    );
    const ids = new Set(created.map((comment) => comment.id));
    expect(ids.size).toBe(20);
    const { comments } = await listComments(dir);
    expect(comments).toHaveLength(20);
    expect(new Set(comments.map((comment) => comment.id))).toEqual(ids);
    expect(comments.map((comment) => comment.text).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `komentar ${index}`).sort(),
    );
    await noTempFiles();
  });
});

describe("stamp dan model desain", () => {
  test("stamp berubah setelah komentar ditambah", async () => {
    const before = await designStamp(dir);
    await addComment(dir, VALID);
    expect(await designStamp(dir)).not.toBe(before);
  });

  test("comments.json bukan halaman atau aset", async () => {
    await addComment(dir, VALID);
    const names = await readdir(join(dir, "design", "pages"));
    expect(names.sort()).toEqual(["contoh.html", "home.html"]);
    expect(await readdir(join(dir, "design", "assets"))).toEqual([]);
  });
});
