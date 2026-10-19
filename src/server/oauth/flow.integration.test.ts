import { describe, expect, test } from "bun:test";
import { authenticate, createToken, listTokens, revokeToken } from "@/server/agents/service";
import { mcpNoStream, mcpPost } from "@/server/agents/transport";
import { POST as revoke } from "@/app/oauth/revoke/route";
import { listConnections, revokeConnection } from "./service";
import { client, code, exchange, form, oauthFixture, refresh, rpc, Tokens } from "./test-fixture";

for (const mode of ["sqlite", "postgres"] as const) describe(`OAuth lifecycle (${mode})`, () => {
  const fixture = oauthFixture(mode);

  test("PKCE exchange issues scoped agent tokens and stores hashes only", async () => {
    const app = await client();
    const authorizationCode = await code(fixture.owner(), app);
    const response = await exchange(app, authorizationCode);
    const tokens = Tokens.parse(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe("read capture");
    expect((await authenticate(tokens.access_token)).scopes).toEqual(["read", "capture"]);
    const stored = await fixture.stored();
    for (const secret of [authorizationCode, tokens.access_token, tokens.refresh_token]) expect(stored).not.toContain(secret);
    expect(await listTokens()).toEqual([]);
    expect(await listConnections(fixture.owner())).toHaveLength(1);
  });

  test("wrong verifier cannot consume the authorization code", async () => {
    const app = await client();
    const authorizationCode = await code(fixture.owner(), app);
    const failed = await exchange(app, authorizationCode, { code_verifier: "z".repeat(43) });
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toBe("invalid_grant");
    expect((await exchange(app, authorizationCode)).status).toBe(200);
  });

  test("code replay commits revocation of access and refresh tokens", async () => {
    const app = await client();
    const authorizationCode = await code(fixture.owner(), app);
    const issued = Tokens.parse(await (await exchange(app, authorizationCode)).json());
    expect((await exchange(app, authorizationCode)).status).toBe(400);
    await expect(authenticate(issued.access_token)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
    expect((await listConnections(fixture.owner()))[0]?.revokedAt).not.toBeNull();
  });

  test("concurrent code exchanges leave no live token after replay", async () => {
    const app = await client();
    const authorizationCode = await code(fixture.owner(), app);
    const responses = await Promise.all([exchange(app, authorizationCode), exchange(app, authorizationCode)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    const success = responses.find(response => response.status === 200);
    if (!success) throw new Error("Expected one successful exchange");
    const issued = Tokens.parse(await success.json());
    await expect(authenticate(issued.access_token)).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("refresh rotation returns new secrets but only one settings connection", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    const rotated = Tokens.parse(await (await refresh(app, issued.refresh_token)).json());
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect(rotated.access_token).not.toBe(issued.access_token);
    expect((await authenticate(rotated.access_token)).scopes).toEqual(["read", "capture"]);
    expect(await listConnections(fixture.owner())).toHaveLength(1);
    expect(await listTokens()).toEqual([]);
  });

  test("rotated refresh reuse revokes every access token and the new refresh token", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    const rotated = Tokens.parse(await (await refresh(app, issued.refresh_token)).json());
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
    for (const secret of [issued.access_token, rotated.access_token]) {
      await expect(authenticate(secret)).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect((await refresh(app, rotated.refresh_token)).status).toBe(400);
  });

  test("expired access tokens get the discovery challenge on POST and GET", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    await fixture.execute("UPDATE agent_tokens SET expires_at='2000-01-01T00:00:00Z'",
      "UPDATE agent_tokens SET expires_at='2000-01-01T00:00:00.000000Z'");
    for (const handler of [mcpPost, mcpNoStream]) {
      const response = await handler(rpc(issued.access_token));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(response.headers.get("www-authenticate")).toContain('scope="read capture"');
    }
  });

  test("expired authorization and refresh credentials cannot mint access", async () => {
    const app = await client();
    const authorizationCode = await code(fixture.owner(), app);
    await fixture.execute("UPDATE oauth_codes SET expires_at='2000-01-01T00:00:00Z'",
      "UPDATE oauth_codes SET expires_at='2000-01-01T00:00:00.000000Z'");
    expect((await exchange(app, authorizationCode)).status).toBe(400);
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    await fixture.execute("UPDATE oauth_refresh_tokens SET expires_at='2000-01-01T00:00:00Z'",
      "UPDATE oauth_refresh_tokens SET expires_at='2000-01-01T00:00:00.000000Z'");
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
  });

  for (const tokenType of ["access_token", "refresh_token"] as const) test(`revoke endpoint accepts ${tokenType} without disclosing existence`, async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    expect((await revoke(form("/oauth/revoke", { token: issued[tokenType], client_id: app.client_id }))).status).toBe(200);
    expect((await revoke(form("/oauth/revoke", { token: "unknown" }))).status).toBe(200);
    await expect(authenticate(issued.access_token)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
  });

  test("settings grant revocation kills OAuth while existing bearer tokens keep working", async () => {
    const bearer = await createToken({ name: "Existing bearer", scopes: ["read"], allowedNoteIds: [] });
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    const grant = (await listConnections(fixture.owner()))[0];
    if (!grant) throw new Error("Missing connection");
    await revokeConnection(grant.id, fixture.owner());
    await expect(authenticate(issued.access_token)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
    expect(await authenticate(bearer.secret)).toEqual(bearer.token);
    expect(await listTokens()).toEqual([bearer.token]);
  });

  test("the existing token revocation service also revokes its OAuth grant", async () => {
    const app = await client();
    const issued = Tokens.parse(await (await exchange(app, await code(fixture.owner(), app))).json());
    await revokeToken((await authenticate(issued.access_token)).id);
    expect((await refresh(app, issued.refresh_token)).status).toBe(400);
    expect((await mcpPost(rpc(issued.access_token))).status).toBe(401);
  });
});
