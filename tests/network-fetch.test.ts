import { describe, expect, test } from "bun:test";
import {
  DESKTOP_PATH_PREFIX,
  PEER_HEADER,
  SECURE_HEADER,
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

describe("header proksi Cloudflare Tunnel", () => {
  const PUBLIK = "jejak.contoh.com";
  const LOOPBACK: SocketLike = { requestIP: () => ({ address: "127.0.0.1" }) };

  function tunnelRequest(headers: Record<string, string> = {}): Request {
    return new Request(`http://${PUBLIK}/api/auth/login`, {
      headers: { host: PUBLIK, ...headers },
    });
  }

  async function run(
    request: Request,
    server: SocketLike,
    publicHost: () => string | undefined = () => PUBLIK,
  ): Promise<Request> {
    let dilihat: Request | undefined;
    const fetch = networkFetch(
      (req) => {
        dilihat = req;
        return new Response("ok");
      },
      (req, srv) => srv?.requestIP?.(req)?.address,
      { publicHost },
    );
    await fetch(request, server);
    if (dilihat === undefined) throw new Error("permintaan tak diteruskan");
    return dilihat;
  }

  test("cf-connecting-ip dipakai sebagai peer dari loopback pada host publik", async () => {
    const dilihat = await run(
      tunnelRequest({ "cf-connecting-ip": "203.0.113.9" }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(PEER_HEADER)).toBe("203.0.113.9");
  });

  test("cf-connecting-ip diabaikan dari peer non-loopback", async () => {
    const dilihat = await run(
      tunnelRequest({ "cf-connecting-ip": "203.0.113.9" }),
      SERVER,
    );
    expect(dilihat.headers.get(PEER_HEADER)).toBe("192.168.1.7");
  });

  test("cf-connecting-ip diabaikan pada host lain", async () => {
    const dilihat = await run(
      new Request("http://192.168.1.5:4747/api/auth/login", {
        headers: { host: "192.168.1.5:4747", "cf-connecting-ip": "203.0.113.9" },
      }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(PEER_HEADER)).toBe("127.0.0.1");
  });

  test("cf-connecting-ip tak sah diabaikan", async () => {
    const dilihat = await run(
      tunnelRequest({ "cf-connecting-ip": "bukan-ip" }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(PEER_HEADER)).toBe("127.0.0.1");
  });

  test("x-forwarded-for tak pernah dipercaya", async () => {
    const dilihat = await run(
      tunnelRequest({ "x-forwarded-for": "203.0.113.9" }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(PEER_HEADER)).toBe("127.0.0.1");
  });

  test("x-forwarded-proto https dari loopback pada host publik menandai secure", async () => {
    const dilihat = await run(
      tunnelRequest({ "x-forwarded-proto": "https" }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(SECURE_HEADER)).toBe("1");
  });

  test("cf-visitor scheme https juga menandai secure", async () => {
    const dilihat = await run(
      tunnelRequest({ "cf-visitor": '{"scheme":"https"}' }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(SECURE_HEADER)).toBe("1");
  });

  test("x-forwarded-proto dari peer non-loopback diabaikan", async () => {
    const dilihat = await run(
      tunnelRequest({ "x-forwarded-proto": "https" }),
      SERVER,
    );
    expect(dilihat.headers.get(SECURE_HEADER)).toBeNull();
  });

  test("x-forwarded-proto pada host lain diabaikan", async () => {
    const dilihat = await run(
      new Request("http://192.168.1.5:4747/api/auth/login", {
        headers: { host: "192.168.1.5:4747", "x-forwarded-proto": "https" },
      }),
      LOOPBACK,
    );
    expect(dilihat.headers.get(SECURE_HEADER)).toBeNull();
  });

  test("header proksi dari klien dibuang lebih dulu", async () => {
    const dilihat = await run(
      tunnelRequest({
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-proto": "https",
        "cf-visitor": '{"scheme":"https"}',
      }),
      SERVER,
    );
    expect(dilihat.headers.get("cf-connecting-ip")).toBeNull();
    expect(dilihat.headers.get("x-forwarded-proto")).toBeNull();
    expect(dilihat.headers.get("cf-visitor")).toBeNull();
  });
});

describe("pembungkus fetch listener utama", () => {  test("header penanda dari klien dibuang dan via tak pernah disetel", async () => {
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
