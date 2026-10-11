import { expect, test } from "bun:test";
import { sqliteStore, closeSQLiteStore } from "@/server/db/backend";
import { sqliteTimestamp } from "@/server/db/sqlite/values";
import { openSQLite } from "@/server/db/sqlite";
import { finishOpenRouterAuth } from "./callback";
import { submitAuthCode } from "./code";
import { cancelAuthAttempt, pollAuthAttempt } from "./poll";
import { startAuthAttempt } from "./start";
import { bounded, fakeFetch, fixedNow, sqliteAuthFixture, sqliteOwnerScope } from "./sqlite-test-fixture";

sqliteAuthFixture();
const origin = "https://fixture.example";

test("Google authorization persists a claim visible to concurrent pollers with only one token POST", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const attempt = await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => fixedNow });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const fetchImpl = fakeFetch(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600 });
  });
  const entry = bounded(entered.promise);
  const submitted = submitAuthCode({ id: attempt.id, code: "4/fixture-code" }, scope, { fetchImpl, now: () => fixedNow });
  // When / Then
  try {
    await entry;
    const filename = process.env.ARO_SQLITE_PATH;
    if (!filename) throw new Error("Missing SQLite filename");
    using other = openSQLite({ filename, busyTimeoutMs: 0 });
    expect(JSON.parse(other.get<{ payload: string }>("SELECT payload FROM ai_auth_attempts WHERE id=?", [attempt.id])?.payload ?? "{}"))
      .toMatchObject({ exchangeState: "in_flight" });
    expect(await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => fixedNow }))
      .toMatchObject({ status: "pending", requiresCode: false });
    await expect(submitAuthCode({ id: attempt.id, code: "4/other-code" }, scope, { fetchImpl, now: () => fixedNow }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(calls).toBe(1);
  } finally { release.resolve(); }
  expect((await submitted).status).toBe("ready");
  expect(JSON.stringify(await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => fixedNow })))
    .not.toContain("private-access");
});

test.each(["cancel", "expire"] as const)("Google late completion cannot resurrect after %s", async action => {
  // Given
  const scope = await sqliteOwnerScope();
  let now = fixedNow;
  const attempt = await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => now });
  const fetchImpl = fakeFetch(async () => {
    if (action === "cancel") await cancelAuthAttempt(attempt.id, scope);
    else now = attempt.expiresAt;
    return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600 });
  });
  // When
  const submitted = submitAuthCode({ id: attempt.id, code: "4/fixture-code" }, scope, { fetchImpl, now: () => now });
  // Then
  if (action === "cancel") await expect(submitted).rejects.toMatchObject({ code: "not_found" });
  else expect((await submitted).status).toBe("expired");
  expect((await sqliteStore()).all("SELECT id FROM ai_auth_attempts WHERE status='ready'")).toHaveLength(0);
});

test.each(["ambiguous", "server"] as const)("Google %s exchange failures enforce durable retry policy", async failure => {
  // Given
  const scope = await sqliteOwnerScope();
  let now = fixedNow;
  const attempt = await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => now });
  let calls = 0;
  const fetchImpl = fakeFetch(() => {
    calls++;
    if (calls === 1) {
      if (failure === "ambiguous") throw new TypeError("fixture disconnected");
      return Response.json({ error: "server_error" }, { status: 503 });
    }
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  });
  // When
  const result = await submitAuthCode({ id: attempt.id, code: "4/fixture-code" }, scope, { fetchImpl, now: () => now });
  await closeSQLiteStore();
  now += 6000;
  const retry = await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => now });
  // Then
  expect(result.status).toBe(failure === "ambiguous" ? "failed" : "pending");
  expect(retry.status).toBe(failure === "ambiguous" ? "failed" : "ready");
  expect(calls).toBe(failure === "ambiguous" ? 1 : 2);
});

test("OpenRouter callback binds the browser and concurrent polling cannot replay the key exchange", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const attempt = await startAuthAttempt({ provider: "openrouter", callbackOrigin: origin }, scope, { now: () => fixedNow });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const fetchImpl = fakeFetch(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return Response.json({ key: "fixture-private-key" });
  });
  await expect(finishOpenRouterAuth({ id: attempt.id, code: "fixture", browserHash: "wrong" },
    { fetchImpl, now: () => fixedNow })).rejects.toMatchObject({ code: "forbidden" });
  const entry = bounded(entered.promise);
  const completion = finishOpenRouterAuth({ id: attempt.id, code: "fixture", browserHash: scope.browserHash },
    { fetchImpl, now: () => fixedNow });
  // When / Then
  try {
    await entry;
    expect((await pollAuthAttempt(attempt.id, scope, { fetchImpl, now: () => fixedNow })).status).toBe("pending");
    expect(calls).toBe(1);
    await expect(finishOpenRouterAuth({ id: attempt.id, code: "other", browserHash: scope.browserHash },
      { fetchImpl, now: () => fixedNow })).rejects.toMatchObject({ code: "conflict" });
  } finally { release.resolve(); }
  expect(await completion).toEqual({ success: true, setup: false });
});

test("attempt limits, scope binding, expiration cleanup and cancellation persist natively", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const attempts = [];
  for (let i = 0; i < 8; i++) {
    attempts.push(await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => fixedNow }));
  }
  const first = attempts[0];
  if (!first) throw new Error("Missing fixture attempt");
  // When / Then
  await expect(startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => fixedNow }))
    .rejects.toMatchObject({ code: "rate_limited" });
  for (const wrong of [{ ...scope, browserHash: "wrong" }, { ...scope, key: "owner:other" }]) {
    await expect(pollAuthAttempt(first.id, wrong, { now: () => fixedNow })).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelAuthAttempt(first.id, wrong)).rejects.toMatchObject({ code: "forbidden" });
  }
  await cancelAuthAttempt(first.id, scope);
  expect((await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => fixedNow })).status)
    .toBe("pending");
  (await sqliteStore()).run("UPDATE ai_auth_attempts SET expires_at=?", [sqliteTimestamp(new Date(fixedNow))]);
  await startAuthAttempt({ provider: "google", callbackOrigin: origin }, scope, { now: () => fixedNow });
  expect((await sqliteStore()).all("SELECT id FROM ai_auth_attempts")).toHaveLength(1);
});

test("a cancelled start is not recreated after a delayed device authorization response", async () => {
  // Given
  const scope = await sqliteOwnerScope();
  const fetchImpl = fakeFetch(async () => {
    const row = (await sqliteStore()).get<{ id: string }>("SELECT id FROM ai_auth_attempts WHERE status='starting'");
    if (!row) throw new Error("Missing starting reservation");
    await cancelAuthAttempt(row.id, scope);
    return Response.json({ device_code: "device", user_code: "USER", verification_uri: "https://auth.x.ai/activate",
      interval: 5, expires_in: 600 });
  });
  // When / Then
  await expect(startAuthAttempt({ provider: "xai", callbackOrigin: origin }, scope, { fetchImpl, now: () => fixedNow }))
    .rejects.toMatchObject({ code: "not_found" });
  expect((await sqliteStore()).all("SELECT id FROM ai_auth_attempts")).toHaveLength(0);
});
