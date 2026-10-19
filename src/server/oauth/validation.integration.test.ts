import { describe, expect, test } from "bun:test";
import { OPTIONS as options, POST as register } from "@/app/oauth/register/route";
import { POST as token } from "@/app/oauth/token/route";
import { approve, validateAuthorization } from "./service";
import {
  authorizationParams, client, code, exchange, form, oauthFixture, ORIGIN, REDIRECT,
  refresh, registration, RESOURCE, Tokens, VERIFIER,
} from "./test-fixture";

for (const mode of ["sqlite", "postgres"] as const) describe(`OAuth validation (${mode})`, () => {
  const fixture = oauthFixture(mode);

  test("registration rejects unsafe redirects and invalid client metadata", async () => {
    for (const redirect of ["http://evil.example/callback", "ftp://example.com/a", "https://x.test/a#fragment",
      "https://user:password@x.test/a", "javascript:alert(1)", "http://localhost.evil/a", "http://[::1]/a", "//x.test/a"]) {
      const response = await registration({ redirect_uris: [redirect] });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_redirect_uri");
    }
    for (const input of [{ redirect_uris: [] }, { redirect_uris: Array(6).fill(REDIRECT) }, { client_name: "x".repeat(101) },
      { token_endpoint_auth_method: "private_key_jwt" }]) {
      expect((await registration(input)).status).toBe(400);
    }
  });

  test("registration accepts HTTPS connector redirects and HTTP loopback callbacks", async () => {
    const redirects = ["https://chatgpt.com/connector/unique", "https://platform.openai.com/apps-manage/oauth",
      "https://claude.ai/api/mcp/auth_callback", "http://localhost:3456/callback", "http://127.0.0.1:3456/callback"];
    const response = await registration({ redirect_uris: redirects });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.redirect_uris).toEqual(redirects);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
  });

  test("authorization enforces client redirect PKCE response type resource and scope", async () => {
    const app = await client();
    const invalid: Record<string, string>[] = [
      { client_id: "unknown" }, { redirect_uri: `${REDIRECT}/different` }, { redirect_uri: `${REDIRECT}?added=1` },
      { response_type: "token" }, { code_challenge_method: "plain" }, { code_challenge: "short" },
      { resource: "https://other.example/api/mcp" }, { scope: "read admin" }, { scope: "read read" },
    ];
    for (const extra of invalid) {
      await expect(validateAuthorization(authorizationParams(app.client_id, extra), RESOURCE)).rejects.toThrow();
    }
    const duplicate = authorizationParams(app.client_id);
    duplicate.append("redirect_uri", REDIRECT);
    await expect(validateAuthorization(duplicate, RESOURCE)).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("approval cannot elevate permissions beyond the client's requested scopes", async () => {
    const app = await client();
    const auth = await validateAuthorization(authorizationParams(app.client_id, { scope: "read" }), RESOURCE);
    await expect(approve(auth, fixture.owner(), ["read", "capture"])).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(approve(auth, fixture.owner(), [])).rejects.toMatchObject({ code: "invalid_scope" });
  });

  test("code binding rejects wrong client redirect and resource without consuming it", async () => {
    const app = await client();
    const other = await client();
    const authorizationCode = await code(fixture.owner(), app);
    const mismatches: Record<string, string>[] = [{ client_id: other.client_id }, { redirect_uri: `${REDIRECT}/other` }, { resource: "https://evil.example/api/mcp" }];
    for (const extra of mismatches) {
      expect((await exchange(app, authorizationCode, extra)).status).toBe(400);
    }
    expect((await exchange(app, authorizationCode)).status).toBe(200);
  });

  for (const method of ["client_secret_basic", "client_secret_post"] as const) test(`confidential ${method} clients must authenticate and use PKCE`, async () => {
    const app = await client({ token_endpoint_auth_method: method });
    expect(app.client_secret?.length).toBeGreaterThanOrEqual(43);
    const authorizationCode = await code(fixture.owner(), app);
    expect((await exchange(app, authorizationCode)).status).toBe(401);
    const password = app.client_secret ?? "";
    const headers: Record<string, string> = method === "client_secret_basic" ? { authorization: `Basic ${Buffer.from(`${app.client_id}:${password}`).toString("base64")}` } : {};
    const extra: Record<string, string> = method === "client_secret_post" ? { client_secret: password } : {};
    const wrong: Record<string, string> = method === "client_secret_post" ? { client_secret: "wrong" } : {};
    const wrongHeaders: Record<string, string> = method === "client_secret_basic" ? { authorization: `Basic ${Buffer.from(`${app.client_id}:wrong`).toString("base64")}` } : {};
    expect((await exchange(app, authorizationCode, wrong, wrongHeaders)).status).toBe(401);
    expect((await exchange(app, authorizationCode, { ...extra, code_verifier: "z".repeat(43) }, headers)).status).toBe(400);
    const response = await exchange(app, authorizationCode, extra, headers);
    expect(response.status).toBe(200);
    const issued = Tokens.parse(await response.json());
    expect((await refresh(app, issued.refresh_token)).status).toBe(401);
    expect(await fixture.stored()).not.toContain(password);
  });

  test("Basic client credentials work without a body client_id", async () => {
    const app = await client({ token_endpoint_auth_method: "client_secret_basic" });
    const response = await token(form("/oauth/token", {
      grant_type: "authorization_code", code: await code(fixture.owner(), app),
      redirect_uri: REDIRECT, code_verifier: VERIFIER,
    }, { authorization: `Basic ${Buffer.from(`${app.client_id}:${app.client_secret}`).toString("base64")}` }));
    expect(response.status).toBe(200);
  });

  test("token request rejects duplicate parameters unsupported grant and oversized bodies", async () => {
    const app = await client();
    const request = form("/oauth/token", { client_id: app.client_id, grant_type: "password" });
    expect((await (await token(request)).json()).error).toBe("unsupported_grant_type");
    const duplicate = new Request(`${ORIGIN}/oauth/token`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: "client_id=a&client_id=b" });
    expect((await token(duplicate)).status).toBe(400);
    expect((await register(new Request(`${ORIGIN}/oauth/register`, { method: "POST",
      headers: { "content-type": "application/json" }, body: " ".repeat(96 * 1024 + 1) }))).status).toBe(413);
  });

  test("registration rate limit is persisted and browser preflight carries no credentials", async () => {
    for (let i = 0; i < 20; i++) expect((await registration()).status).toBe(201);
    expect((await registration()).status).toBe(429);
    const response = options(new Request(`${ORIGIN}/oauth/register`, { method: "OPTIONS",
      headers: { origin: "https://chatgpt.com", "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
  });
});
