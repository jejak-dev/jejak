import { describe, expect, test } from "bun:test";
import {
  DESKTOP_PATH_PREFIX,
  PEER_HEADER,
  VIA_HEADER,
  VIA_NETWORK,
  mainFetch,
  networkFetch,
  type SocketLike,
} from "../src/server/network/network-fetch";

/** Peladen tiruan: alamat socket selalu sama. */
const SERVER: SocketLike = {
  requestIP: () => ({ address: "192.168.1.7" }),
};

function request(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Request {
  return new Request(`http://192.168.1.5:4747${path}`, {
    method,
    headers: { host: "192.168.1.5:4747", ...headers },
  });
}

describe("pembungkus fetch listener jaringan", () => {
  test("header penanda dari klien dibuang dan diganti milik server", async () => {
    let dilihat: Request | undefined;
    const fetch = networkFetch(
      (req) => {
        dilihat = req;
        return new Response("ok");
      },
      (req, server) => server?.requestIP?.(req)?.address,
    );
    await fetch(
      request("/api/network", {
        [VIA_HEADER]: "net",
        [PEER_HEADER]: "1.2.3.4",
      }),
      SERVER,
    );
    expect(dilihat?.headers.get(VIA_HEADER)).toBe(VIA_NETWORK);
    expect(dilihat?.headers.get(PEER_HEADER)).toBe("192.168.1.7");
  });

  test("path desktop dijawab 404 tanpa menyentuh aplikasi", async () => {
    let dipanggil = false;
    const fetch = networkFetch(
      () => {
        dipanggil = true;
        return new Response("ok");
      },
      () => undefined,
    );
    const res = await fetch(request(`${DESKTOP_PATH_PREFIX}enter?t=abc`), SERVER);
    expect(res.status).toBe(404);
    expect(dipanggil).toBe(false);
  });

  test("header lain tetap ikut ke aplikasi", async () => {
    let dilihat: Request | undefined;
    const fetch = networkFetch(
      (req) => {
        dilihat = req;
        return new Response("ok");
      },
      () => undefined,
    );
    await fetch(request("/api/network", { "content-type": "application/json" }), SERVER);
    expect(dilihat?.headers.get("content-type")).toBe("application/json");
  });
});

describe("pembungkus fetch listener utama", () => {
  test("header penanda dari klien dibuang dan via tak pernah disetel", async () => {
    let dilihat: Request | undefined;
    const fetch = mainFetch(
      (req) => {
        dilihat = req;
        return new Response("ok");
      },
      (req, server) => server?.requestIP?.(req)?.address,
    );
    await fetch(
      request("/api/network", {
        [VIA_HEADER]: "net",
        [PEER_HEADER]: "1.2.3.4",
      }),
      SERVER,
    );
    expect(dilihat?.headers.get(VIA_HEADER)).toBeNull();
    expect(dilihat?.headers.get(PEER_HEADER)).toBe("192.168.1.7");
  });

  test("socket tak diketahui: header peer tak diisi", async () => {
    let dilihat: Request | undefined;
    const fetch = mainFetch(
      (req) => {
        dilihat = req;
        return new Response("ok");
      },
      () => undefined,
    );
    await fetch(request("/api/network"), SERVER);
    expect(dilihat?.headers.get(PEER_HEADER)).toBeNull();
  });
});
