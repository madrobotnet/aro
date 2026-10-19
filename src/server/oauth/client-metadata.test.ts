import { expect, test } from "bun:test";
import { fetchClientMetadata } from "./client-metadata";

const ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const document = { client_id: ID, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
const publicResolve = async () => ["93.184.216.34"];

test("client metadata is fetched over pinned HTTPS and exact document identity is required", async () => {
  const seen: { url: string; address: string; redirect?: RequestRedirect }[] = [];
  const client = await fetchClientMetadata(ID, { resolve: publicResolve, fetch: async (url, address, init) => {
    seen.push({ url: url.href, address, redirect: init?.redirect });
    return Response.json(document);
  } });
  expect(client.id).toBe(ID);
  expect(client.name).toBe("Claude");
  expect(JSON.parse(client.redirect_uris)).toEqual(document.redirect_uris);
  expect(seen).toEqual([{ url: ID, address: "93.184.216.34", redirect: "manual" }]);
  await expect(fetchClientMetadata(ID, { resolve: publicResolve,
    fetch: async () => Response.json({ ...document, client_id: "https://attacker.example/metadata" }),
  })).rejects.toMatchObject({ code: "invalid_client" });
});

test("claude.ai's published metadata document with extra grant types and client_uri is accepted", async () => {
  const live = { ...document, client_uri: "https://claude.ai", response_types: ["code"], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"] };
  const client = await fetchClientMetadata(ID, { resolve: publicResolve, fetch: async () => Response.json(live) });
  expect(client.name).toBe("Claude");
  expect(JSON.parse(client.redirect_uris)).toEqual(live.redirect_uris);
  await expect(fetchClientMetadata(ID, { resolve: publicResolve,
    fetch: async () => Response.json({ ...live, grant_types: ["refresh_token"] }),
  })).rejects.toMatchObject({ code: "invalid_client" });
});

test("private loopback link-local and mixed DNS destinations are rejected before fetching", async () => {
  let fetches = 0;
  const fetch = async () => { fetches++; return Response.json(document); };
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "::1", "fc00::1", "fe80::1", "::ffff:7f00:1", "100.64.0.1"]) {
    await expect(fetchClientMetadata(ID, { resolve: async () => [address], fetch })).rejects.toMatchObject({ code: "invalid_client" });
  }
  await expect(fetchClientMetadata(ID, { resolve: async () => ["93.184.216.34", "127.0.0.1"], fetch })).rejects.toThrow();
  for (const url of ["http://claude.ai/meta", "https://localhost/meta", "https://127.0.0.1/meta",
    "https://[::1]/meta", "https://user:pass@claude.ai/meta", `${ID}#fragment`]) {
    await expect(fetchClientMetadata(url, { resolve: publicResolve, fetch })).rejects.toThrow();
  }
  expect(fetches).toBe(0);
});

test("redirects HTML malformed documents and oversized streamed metadata are rejected", async () => {
  const responses = [
    Response.redirect("http://127.0.0.1/private"),
    Response.redirect("https://private.example/metadata"),
    new Response("<html>not JSON</html>", { headers: { "content-type": "text/html" } }),
    Response.json({ ...document, redirect_uris: ["http://evil.example/callback"] }),
    Response.json({ ...document, token_endpoint_auth_method: "client_secret_basic" }),
    new Response("not json", { headers: { "content-type": "application/json" } }),
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(16 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } }), { headers: { "content-type": "application/json", "content-length": "1" } }),
  ];
  for (const response of responses) {
    await expect(fetchClientMetadata(ID, { resolve: publicResolve, fetch: async () => response })).rejects.toMatchObject({ code: "invalid_client" });
  }
});

test("an abort bounds an unresolved DNS lookup without sleeps", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const result = fetchClientMetadata(ID, { signal: controller.signal, resolve: () => {
    started.resolve();
    return new Promise<readonly string[]>(() => {});
  } });
  await started.promise;
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: "invalid_client" });
});
