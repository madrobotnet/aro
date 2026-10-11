import { expect, test } from "bun:test";
import { pollAuthAttempt } from "./poll";
import { startAuthAttempt } from "./start";
import { fakeFetch, fixedNow, sqliteAuthFixture, sqliteOwnerScope } from "./sqlite-test-fixture";
import { sqliteStore } from "@/server/db/backend";

sqliteAuthFixture();
const origin = "https://fixture.example";

test.each(["xai", "github-copilot", "openai"] as const)("%s device flow persists authorized credentials without provider work in the writer", async provider => {
  // Given
  const scope = await sqliteOwnerScope();
  let now = fixedNow;
  let calls = 0;
  const fetchImpl = fakeFetch(async (url, init) => {
    calls++;
    // A provider fake can perform an independent synchronous writer operation.
    (await sqliteStore()).transaction(executor => {
      executor.run("UPDATE users SET updated_at=updated_at");
    });
    if (url.includes("/device/code")) return Response.json({
      device_code: "fixture-device", user_code: "USER-CODE",
      verification_uri: "https://fixture.example/device", interval: 5, expires_in: 600,
    });
    if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "fixture-device", usercode: "USER-CODE", interval: "5" });
    if (url.includes("deviceauth/token")) return Response.json({
      authorization_code: "fixture-code", code_verifier: "fixture-verifier", code_challenge: "challenge",
    });
    if (url.includes("copilot_internal")) return Response.json({ token: "copilot-access", expires_at: now / 1000 + 3600 });
    if (provider === "github-copilot") return Response.json({ access_token: "github-retained-token" });
    if (provider === "openai") {
      expect(new URLSearchParams(String(init?.body)).get("code")).toBe("fixture-code");
      const id = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
      return Response.json({ access_token: "openai-access", refresh_token: "openai-refresh", id_token: id, expires_in: 3600 });
    }
    return Response.json({ access_token: "xai-access", refresh_token: "xai-refresh", expires_in: 3600 });
  });
  const attempt = await startAuthAttempt({ provider, callbackOrigin: origin }, scope, { fetchImpl, now: () => now });
  now += 5000;
  // When
  const ready = await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => now });
  // Then
  expect(ready.status).toBe("ready");
  const row = (await sqliteStore()).get<{ payload: string }>("SELECT payload FROM ai_auth_attempts WHERE id=?", [attempt.id]);
  expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ provider,
    accessToken: provider === "github-copilot" ? "copilot-access" : `${provider}-access` });
  expect(calls).toBe(provider === "xai" ? 2 : 3);
});

test("xAI slowdown persists an increased interval without polling early", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  let now = fixedNow;
  let calls = 0;
  const fetchImpl = fakeFetch(url => {
    calls++;
    if (url.endsWith("/device/code")) return Response.json({
      device_code: "device", user_code: "USER", verification_uri: "https://fixture.example/device", interval: 5, expires_in: 600,
    });
    return Response.json({ error: "slow_down", interval: 11 }, { status: 400 });
  });
  const attempt = await startAuthAttempt({ provider: "xai", callbackOrigin: origin }, scope, { fetchImpl, now: () => now });
  now += 5000;
  // When
  const delayed = await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => now });
  const early = await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => now });
  // Then
  expect(delayed.retryAfterMs).toBeGreaterThanOrEqual(11000);
  expect(early).toEqual(delayed);
  expect(calls).toBe(2);
});
