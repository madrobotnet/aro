import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

test.each(["aro_session", "sb_session"])("accepts %s at the proxy gate", (name) => {
  const response = proxy(new NextRequest("https://brain.example/api/notes", {
    headers: { cookie: `${name}=fixture-token` },
  }));
  expect(response.headers.get("x-middleware-next")).toBe("1");
});

test("opens only exact read-only share capabilities while private APIs stay protected", () => {
  const token = "a".repeat(64);
  for (const method of ["GET", "HEAD"]) {
    const response = proxy(new NextRequest(`https://brain.example/share/${token}`, { method }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  for (const path of ["/share", "/share/", `/share/${token}/extra`, `/share/${"A".repeat(64)}`]) {
    const response = proxy(new NextRequest(`https://brain.example${path}`));
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(proxy(new NextRequest(`https://brain.example/share/${token}`, { method: "POST" })).headers.get("x-middleware-next")).toBeNull();
  for (const path of ["/api/attachments/private", "/api/notes/id/shares", "/api/notes/id/shares/share-id", "/api/notes/id"]) {
    expect(proxy(new NextRequest(`https://brain.example${path}`)).status).toBe(401);
  }
});

test("serves public login fonts without a session", () => {
  const response = proxy(new NextRequest("https://brain.example/fonts/PretendardVariable.woff2"));

  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("location")).toBeNull();
});

test("keeps note APIs protected without a session", () => {
  const response = proxy(new NextRequest("https://brain.example/api/notes"));

  expect(response.status).toBe(401);
});

test("lets only the exact MCP endpoint perform its own bearer authentication", () => {
  expect(proxy(new NextRequest("https://brain.example/api/mcp", {
    method: "POST", headers: { authorization: "Bearer synthetic-token" },
  })).headers.get("x-middleware-next")).toBe("1");
  for (const path of ["/api/mcp/extra", "/api/agents/tokens", "/api/agents/proposals"]) {
    expect(proxy(new NextRequest(`https://brain.example${path}`)).status).toBe(401);
  }
});

test("lets only the exact capture webhook perform its own bearer authentication", () => {
  expect(proxy(new NextRequest("https://brain.example/api/webhooks/capture", { method: "POST" }))
    .headers.get("x-middleware-next")).toBe("1");
  expect(proxy(new NextRequest("https://brain.example/api/webhooks/capture/extra")).status).toBe(401);
});

test("redirects protected pages without a session", () => {
  const response = proxy(new NextRequest("https://brain.example/notes?tag=work"));
  const location = response.headers.get("location");

  expect(response.status).toBe(307);
  expect(location).toBe("https://brain.example/login?next=%2Fnotes%3Ftag%3Dwork");
});

test("allows only the exact installer entry points without a session", () => {
  for (const path of ["/setup", "/api/setup"]) {
    expect(proxy(new NextRequest(`https://brain.example${path}`)).headers.get("x-middleware-next")).toBe("1");
  }
  expect(proxy(new NextRequest("https://brain.example/api/setup/secrets")).status).toBe(401);
  expect(proxy(new NextRequest("https://brain.example/api/settings/ai")).status).toBe(401);
});

test("establishes a private browser nonce before parallel provider logins", () => {
  const response = proxy(new NextRequest("https://brain.example/setup"));
  const cookie = response.cookies.get("sb_ai_auth");
  expect(cookie?.value).toMatch(/^[a-f0-9]{64}$/);
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("lax");
  expect(cookie?.path).toBe("/");
  const next = proxy(new NextRequest("https://brain.example/setup", {
    headers: { cookie: `sb_ai_auth=${cookie?.value}` },
  }));
  expect(next.headers.get("set-cookie")).toBeNull();
});

test("allows provider login handlers to perform their own owner or installer checks", () => {
  for (const path of ["/api/ai/auth", `/api/ai/auth/${crypto.randomUUID()}`, `/api/ai/auth/openrouter/callback/${crypto.randomUUID()}`, "/connect/complete"]) {
    expect(proxy(new NextRequest(`https://brain.example${path}`)).headers.get("x-middleware-next")).toBe("1");
  }
  expect(proxy(new NextRequest("https://brain.example/api/settings/ai/connections")).status).toBe(401);
});
