import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import {
  AttachmentError,
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  imageTypeOf,
  safeAttachmentName,
} from "../src/server/attachments/store";
import { attachmentRoutes } from "../src/server/routes/attachments";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jejak-att-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const b64 = (text: string): string => Buffer.from(text).toString("base64");

describe("safeAttachmentName", () => {
  test("membuang path dan karakter aneh", () => {
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("C:\\x\\foto saya.png")).toBe("foto saya.png");
    expect(safeAttachmentName("a<b>c?.txt")).toBe("a_b_c_.txt");
    expect(safeAttachmentName("...")).toBe("lampiran");
    expect(safeAttachmentName("")).toBe("lampiran");
    expect(safeAttachmentName(`${"x".repeat(200)}.png`).length).toBeLessThanOrEqual(80);
    expect(safeAttachmentName(`${"x".repeat(200)}.png`).endsWith(".png")).toBe(true);
  });

  test("tipe gambar dari ekstensi; svg tidak dianggap gambar", () => {
    expect(imageTypeOf("a.PNG")).toBe("image/png");
    expect(imageTypeOf("a.svg")).toBeUndefined();
    expect(imageTypeOf("a")).toBeUndefined();
  });
});

describe("AttachmentStore", () => {
  test("menyimpan, lalu resolve hanya untuk id dan nama valid", async () => {
    const store = new AttachmentStore({ root: dir });
    const saved = await store.save("catatan.txt", b64("halo"));
    expect(saved.path.startsWith(dir)).toBe(true);
    expect(saved.image).toBe(false);
    expect(await readFile(saved.path, "utf8")).toBe("halo");
    expect(store.resolve(saved.id, "catatan.txt")).toBe(saved.path);
    expect(store.resolve(saved.id, "../catatan.txt")).toBeUndefined();
    expect(store.resolve("../../etc", "passwd")).toBeUndefined();
    expect(store.resolve(saved.id, "tidak-ada.txt")).toBeUndefined();
  });

  test("menolak tipe salah, kosong, dan terlalu besar", async () => {
    const store = new AttachmentStore({ root: dir });
    await expect(store.save(1, "x")).rejects.toBeInstanceOf(AttachmentError);
    await expect(store.save("a.txt", "")).rejects.toBeInstanceOf(AttachmentError);
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");
    await expect(store.save("a.bin", big)).rejects.toMatchObject({ status: 413 });
  });
});

describe("rute lampiran", () => {
  test("POST lalu GET; gambar disajikan dengan tipenya, lainnya sebagai unduhan", async () => {
    const app = new Elysia().use(attachmentRoutes({ store: new AttachmentStore({ root: dir }) }));
    const post = async (name: string, data: string) =>
      app.handle(
        new Request("http://localhost/api/attachments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, data }),
        }),
      );

    const img = await post("foto.png", b64("PNGDATA"));
    expect(img.status).toBe(201);
    const imgBody = (await img.json()) as { attachment: { id: string; name: string; image: boolean } };
    expect(imgBody.attachment.image).toBe(true);
    const got = await app.handle(
      new Request(`http://localhost/api/attachments/${imgBody.attachment.id}/foto.png`),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");

    const txt = await post("a.html", b64("<script>1</script>"));
    const txtBody = (await txt.json()) as { attachment: { id: string } };
    const dl = await app.handle(
      new Request(`http://localhost/api/attachments/${txtBody.attachment.id}/a.html`),
    );
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
    expect(dl.headers.get("content-disposition")).toBe("attachment");

    expect((await post("a.txt", "")).status).toBe(400);
    const missing = await app.handle(new Request("http://localhost/api/attachments/aaaaaaaaaaaa/x.png"));
    expect(missing.status).toBe(404);
  });
});
