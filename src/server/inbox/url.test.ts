import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, globalAgent as httpsAgent } from "node:https";
import type { Socket } from "node:net";
import {
  fetchUrlText,
  isUnsafeAddress,
  requestPinned,
  URL_FETCH_BYTE_LIMIT,
} from "./url";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQglZBfaxApoc+ieP5W
ZHkS8dkayROGpmCHD8hI7e4V7y2hRANCAAR8o/CrYnDIaDnmxWqveLMw3hbaISf+
4vpgKreOiSWgVvR15CtlLmEu8MHNveXU5B3xqoZLUkUGAOuiuTVPE6Jo
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBpzCCAU2gAwIBAgIUG5op0Cm2W+cd/NqJafs+A3krXZwwCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPY2FwdHVyZS5leGFtcGxlMCAXDTI2MDkyNzE5MzUyNloYDzIx
MjYwOTAzMTkzNTI2WjAaMRgwFgYDVQQDDA9jYXB0dXJlLmV4YW1wbGUwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAR8o/CrYnDIaDnmxWqveLMw3hbaISf+4vpgKreO
iSWgVvR15CtlLmEu8MHNveXU5B3xqoZLUkUGAOuiuTVPE6Joo28wbTAdBgNVHQ4E
FgQUCpQGPvk1QDdrdgf2aeV4g7X8Gl4wHwYDVR0jBBgwFoAUCpQGPvk1QDdrdgf2
aeV4g7X8Gl4wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgg9jYXB0dXJlLmV4
YW1wbGUwCgYIKoZIzj0EAwIDSAAwRQIhALotWV2zsWEbOvkDmNBAGR2eDc69GtAX
kxbvz4rgx5qyAiBcdp3xo878SjeWiMOEw0q/3DRk366CRMRZE0tt9mwOFw==
-----END CERTIFICATE-----`;

const servers = new Set<Server>();
const sockets = new Set<Socket>();

describe("HTML capture text", () => {
  test("extracts article text without quoted attributes or navigation and decodes entities once", async () => {
    const html = `<!doctype html><html><head>
      <title>Introduction &bull; Zettelkasten Method</title>
      <style>.fake { content: "style noise >"; }</style>
      <script>const fake = "<p>script noise</p>";</script>
      </head><body><nav><a href="/start">navigation noise</a></nav>
      <article data-description="ideas > folders" title='one > two'>
      <h1>Getting Started</h1><p>Notes &mdash; ideas &copy; &#169; &#x1F4D6; &nbsp; &amp; connections.</p>
      <p>Literal &amp;lt;tag&amp;gt; and 2 &lt; 3 &gt; 1.</p>
      <!-- comment noise --></article></body></html>`;

    const result = await fetchUrlText("https://example.com/introduction", {
      resolve: async () => ["93.184.216.34"],
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });

    expect(result).toEqual({
      ok: true, url: "https://example.com/introduction",
      text: "Getting Started Notes — ideas © © 📖 & connections. Literal &lt;tag&gt; and 2 < 3 > 1.",
    });
  });

  test("keeps plain text entities and comparisons as supplied", async () => {
    const text = "Notes &amp; examples: a < b and c > d";
    const result = await fetchUrlText("https://example.com/plain", {
      resolve: async () => ["93.184.216.34"],
      fetch: async () => new Response(text, { headers: { "content-type": "text/plain" } }),
    });
    expect(result).toEqual({ ok: true, url: "https://example.com/plain", text });
  });
});

async function listen(server: Server): Promise<number> {
  servers.add(server);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  return address.port;
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for transport event")), 1_000);
      timer.unref();
    }),
  ]);
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  servers.clear();
  sockets.clear();
});

describe("safe URL boundary", () => {
  test("rejects private and reserved DNS answers before transport", async () => {
    expect(isUnsafeAddress("::1")).toBe(true);
    expect(isUnsafeAddress("::ffff:7f00:1")).toBe(true);
    expect(isUnsafeAddress("2001:db8::1")).toBe(true);
    expect(isUnsafeAddress("2606:4700:4700::1111")).toBe(false);
    let fetchCalls = 0;

    const result = await fetchUrlText("https://example.com/private", {
      resolve: async () => ["169.254.169.254"],
      fetch: async () => {
        fetchCalls += 1;
        return new Response("secret");
      },
    });

    expect(result).toEqual({ ok: false, reason: "unsafe_destination" });
    expect(fetchCalls).toBe(0);
  });

  test("aborts while DNS validation is still pending", async () => {
    const controller = new AbortController();
    let resolutionStartedResolve!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => { resolutionStartedResolve = resolve; });
    const resultPromise = fetchUrlText("https://example.com/slow-dns", {
      signal: controller.signal,
      resolve: () => {
        resolutionStartedResolve();
        return new Promise<readonly string[]>(() => undefined);
      },
    });

    await deadline(resolutionStarted);
    controller.abort();

    expect(await deadline(resultPromise)).toEqual({ ok: false, reason: "fetch_failed" });
  });

  test("passes only validated addresses to transport and rechecks redirects", async () => {
    const requests: Array<{ host: string; addresses: readonly string[] }> = [];
    const result = await fetchUrlText("https://example.com/start", {
      resolve: async (host) => host === "example.com" ? ["93.184.216.34"] : ["127.0.0.1"],
      fetch: async (url, addresses) => {
        requests.push({ host: url.hostname, addresses });
        return new Response(null, { status: 302, headers: { location: "http://internal.test/admin" } });
      },
    });

    expect(result).toEqual({ ok: false, reason: "unsafe_destination" });
    expect(requests).toEqual([{ host: "example.com", addresses: ["93.184.216.34"] }]);
  });
});

describe("pinned transport", () => {
  test("connects to the pinned address while preserving the original Host header", async () => {
    let observedHost: string | undefined;
    let observedPeer: string | undefined;
    const server = createServer((request, response) => {
      observedHost = request.headers.host;
      observedPeer = request.socket.remoteAddress;
      response.setHeader("content-type", "text/plain");
      response.end("pinned response");
    });
    const port = await listen(server);

    const response = await requestPinned(new URL(`http://capture.example:${port}/page`), "127.0.0.1");

    expect(await response.text()).toBe("pinned response");
    expect(observedHost).toBe(`capture.example:${port}`);
    expect(observedPeer).toBe("127.0.0.1");
  });

  test("sends the original TLS servername and keeps certificate verification enabled", async () => {
    let servernameResolve!: (value: string | false | null) => void;
    const servername = new Promise<string | false | null>((resolve) => { servernameResolve = resolve; });
    const server = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, (_request, response) => response.end("secure"));
    server.once("secureConnection", (socket) => servernameResolve(socket.servername));
    const port = await listen(server);
    const url = new URL(`https://capture.example:${port}/`);

    await expect(requestPinned(url, "127.0.0.1")).rejects.toThrow("self signed certificate");

    const options = httpsAgent.options as typeof httpsAgent.options & { ca?: string };
    const previousCa = options.ca;
    options.ca = TEST_CERT;
    try {
      const response = await requestPinned(url, "127.0.0.1");
      expect(await response.text()).toBe("secure");
    } finally {
      if (previousCa === undefined) delete options.ca;
      else options.ca = previousCa;
    }
    expect(await deadline(servername)).toBe("capture.example");
  });

  test("cancels an over-limit response body and closes the socket", async () => {
    let bodyClosedResolve!: () => void;
    const bodyClosed = new Promise<void>((resolve) => { bodyClosedResolve = resolve; });
    const server = createServer((_request, response) => {
      response.on("close", bodyClosedResolve);
      response.setHeader("content-type", "text/plain");
      response.write(Buffer.alloc(URL_FETCH_BYTE_LIMIT + 1, 97));
    });
    const port = await listen(server);

    const result = await fetchUrlText(`http://capture.example:${port}/large`, {
      resolve: async () => ["93.184.216.34"],
      fetch: (url, addresses, init) => {
        expect(addresses).toEqual(["93.184.216.34"]);
        return requestPinned(url, "127.0.0.1", init);
      },
    });

    expect(result).toEqual({ ok: false, reason: "unsupported_content" });
    await deadline(bodyClosed);
  });

  test("aborts an in-progress body read and closes the socket", async () => {
    let bodyStartedResolve!: () => void;
    let bodyClosedResolve!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { bodyStartedResolve = resolve; });
    const bodyClosed = new Promise<void>((resolve) => { bodyClosedResolve = resolve; });
    const server = createServer((_request, response) => {
      response.on("close", bodyClosedResolve);
      response.setHeader("content-type", "text/plain");
      response.write("started");
      bodyStartedResolve();
    });
    const port = await listen(server);
    const controller = new AbortController();
    const resultPromise = fetchUrlText(`http://capture.example:${port}/slow`, {
      resolve: async () => ["93.184.216.34"],
      signal: controller.signal,
      fetch: (url, _addresses, init) => requestPinned(url, "127.0.0.1", init),
    });

    await deadline(bodyStarted);
    controller.abort();

    expect(await resultPromise).toEqual({ ok: false, reason: "fetch_failed" });
    await deadline(bodyClosed);
  });
});
