import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  STORAGE_KEY, LEGACY_STORAGE_KEY, LOCK_NAME, migrateDrafts, MAX_BYTES, readDrafts, writeDrafts, prepareFlush, flushDrafts,
} from "../../public/icons/offline-capture-queue.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}
const draft = (text = "thought") => ({
  requestId: crypto.randomUUID(), text, title: "", url: "", createdAt: "2026-01-01T00:00:00Z",
});
const identity = { ownerId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
const ok = () => Response.json({ item: { id: crypto.randomUUID() } }, { status: 201 });
const prepare = (store) => prepareFlush(store, async () => Response.json(identity));

test.each(["read", "write"])("blocked local storage fails without pretending success: %s", (operation) => {
  const store = storage();
  if (operation === "read") {
    store.getItem = () => { throw new DOMException("denied", "SecurityError"); };
    expect(() => readDrafts(store)).toThrow();
  } else {
    store.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
    expect(() => writeDrafts(store, [draft()])).toThrow();
    expect(readDrafts(store)).toEqual([]);
  }
});

test.each(["{", '{"wrong":"shape"}', '[{"requestId":"invalid"}]'])("corrupt storage is preserved: %s", (value) => {
  const store = storage();
  store.setItem(STORAGE_KEY, value);
  expect(() => readDrafts(store)).toThrow();
  expect(store.getItem(STORAGE_KEY)).toBe(value);
});

test("storage bounds reject count, individual size, and total UTF-16 usage", () => {
  const store = storage();
  const original = draft("keep");
  writeDrafts(store, [original]);
  expect(() => writeDrafts(store, Array.from({ length: 51 }, () => draft()))).toThrow();
  expect(() => writeDrafts(store, [draft("x".repeat(20_001))])).toThrow();
  const many = Array.from({ length: 20 }, () => draft("한".repeat(20_000)));
  expect(JSON.stringify(many).length * 2).toBeGreaterThan(MAX_BYTES);
  expect(() => writeDrafts(store, many)).toThrow();
  expect(readDrafts(store)).toEqual([original]);
});

test("saving and preparing never sends; confirmed sending follows persisted insertion order", async () => {
  const store = storage();
  const first = draft("oldest");
  const second = draft("next");
  writeDrafts(store, [first, second]);
  const calls = [];
  const fetcher = async (_url, options) => {
    calls.push(options);
    return options.method === "GET" ? Response.json(identity) : ok();
  };
  expect(calls).toEqual([]);
  const confirmation = await prepareFlush(store, fetcher);
  expect(calls.map((call) => call.method)).toEqual(["GET"]);
  expect(await flushDrafts(store, confirmation, fetcher)).toBe(2);
  expect(calls.slice(1).map((call) => JSON.parse(call.body).requestId)).toEqual([first.requestId, second.requestId]);
  expect(calls.slice(1).map((call) => JSON.parse(call.body).confirmedSessionId)).toEqual([identity.sessionId, identity.sessionId]);
  expect(readDrafts(store)).toEqual([]);
  expect(store.getItem(STORAGE_KEY)).toBe("[]");
});

test("response loss retains exact request UUID/content and stops later drafts", async () => {
  const store = storage();
  const drafts = [draft("possibly committed"), draft("later")];
  writeDrafts(store, drafts);
  const attempted = [];
  await expect(flushDrafts(store, await prepare(store), async (_url, options) => {
    attempted.push(JSON.parse(options.body));
    throw new TypeError("response lost");
  })).rejects.toMatchObject({ code: "ambiguous" });
  expect(readDrafts(store)).toEqual(drafts);
  expect(attempted).toHaveLength(1);
  const repeated = [];
  await flushDrafts(store, await prepare(store), async (_url, options) => {
    repeated.push(JSON.parse(options.body));
    return ok();
  });
  expect(repeated[0]).toEqual(attempted[0]);
  expect(repeated[1].requestId).toBe(drafts[1].requestId);
});

test.each([401, 409, 503])("HTTP %s stops in order and retains current/later drafts", async (code) => {
  const store = storage();
  const drafts = [draft("sent"), draft("failed"), draft("not attempted")];
  writeDrafts(store, drafts);
  let calls = 0;
  await expect(flushDrafts(store, await prepare(store), async () => {
    calls += 1;
    return calls === 1 ? ok() : new Response("", { status: code });
  })).rejects.toMatchObject({ code: code === 401 ? "auth" : code === 409 ? "conflict" : "http" });
  expect(calls).toBe(2);
  expect(readDrafts(store)).toEqual(drafts.slice(1));
});

test("local deletion failure after committed response retains replay identity and halts", async () => {
  const store = storage();
  const drafts = [draft("sent but retained"), draft("later")];
  writeDrafts(store, drafts);
  const confirmation = await prepare(store);
  store.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  let calls = 0;
  await expect(flushDrafts(store, confirmation, async () => { calls += 1; return ok(); }))
    .rejects.toMatchObject({ code: "storage" });
  expect(calls).toBe(1);
  expect(readDrafts(store)).toEqual(drafts);
});

test.each([null, { item: {} }, { item: { id: "wrong" } }])("unverified successful response never deletes draft: %j", async (body) => {
  const store = storage();
  const saved = draft();
  writeDrafts(store, [saved]);
  await expect(flushDrafts(store, await prepare(store), async () => Response.json(body)))
    .rejects.toMatchObject({ code: "ambiguous" });
  expect(readDrafts(store)).toEqual([saved]);
});

test("changed drafts invalidate prior confirmation before any network request", async () => {
  const store = storage();
  writeDrafts(store, [draft()]);
  const confirmation = await prepare(store);
  writeDrafts(store, [...readDrafts(store), draft("another tab")]);
  let calls = 0;
  await expect(flushDrafts(store, confirmation, async () => { calls += 1; return ok(); }))
    .rejects.toMatchObject({ code: "confirmation" });
  expect(calls).toBe(0);
});

test("offline preparation and expired authentication never flush drafts", async () => {
  const store = storage();
  const saved = draft();
  writeDrafts(store, [saved]);
  await expect(prepareFlush(store, async () => { throw new TypeError("offline"); })).rejects.toThrow("offline");
  await expect(prepareFlush(store, async () => new Response("", { status: 401 })))
    .rejects.toMatchObject({ code: "auth" });
  expect(readDrafts(store)).toEqual([saved]);
});

function worker(fetcher = async () => new Response("static")) {
  const handlers = new Map();
  const names = new Map();
  const self = {
    location: { origin: "https://irang.example" },
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async (name) => {
      if (!names.has(name)) names.set(name, new Map());
      const entries = names.get(name);
      return { put: async (path, response) => entries.set(path, response), match: async (path) => entries.get(path) };
    },
    keys: async () => [...names.keys()],
    delete: async (name) => names.delete(name),
  };
  runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), { self, caches, fetch: fetcher, URL });
  return { handlers, names };
}

test("worker precaches only seven public assets, omits credentials and rejects redirects", async () => {
  const calls = [];
  const w = worker(async (url, options) => { calls.push({ url, options }); return new Response("static"); });
  let done;
  w.handlers.get("install")({ waitUntil: (promise) => { done = promise; } });
  await done;
  expect(calls.map((call) => call.url)).toEqual([
    "/icons/offline-capture.html", "/icons/offline-capture.js", "/icons/offline-capture-queue.js",
    "/icons/offline-capture.css", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  ]);
  expect(calls.every((call) => call.options.credentials === "omit" && call.options.redirect === "error")).toBe(true);
  const failed = worker(async () => new Response("", { status: 401 }));
  failed.handlers.get("install")({ waitUntil: (promise) => { done = promise; } });
  await expect(done).rejects.toThrow();
  expect(failed.names.size).toBe(0);
});

test("worker leaves API, authenticated pages, provider URLs and nonallowlisted requests untouched", () => {
  const w = worker();
  for (const [url, method] of [
    ["/api/capture", "GET"], ["/api/notes", "GET"], ["/", "GET"], ["/login", "GET"],
    ["/notes/secret", "GET"], ["/_next/static/chunk.js", "GET"],
    ["/icons/offline-capture.html?secret=1", "GET"], ["/icons/offline-capture.html", "POST"],
    ["https://provider.example/icons/offline-capture.html", "GET"],
  ]) {
    let intercepted = false;
    w.handlers.get("fetch")({
      request: new Request(new URL(url, "https://irang.example"), { method }),
      respondWith: () => { intercepted = true; },
    });
    expect(intercepted).toBe(false);
  }
  expect([...w.handlers.keys()]).toEqual(["install", "activate", "fetch"]);
});

test("worker serves cached public capture offline and cleans only its own older caches", async () => {
  let offline = false;
  const w = worker(async () => {
    if (offline) throw new TypeError("offline");
    return new Response("offline shell");
  });
  let done;
  w.handlers.get("install")({ waitUntil: (promise) => { done = promise; } });
  await done;
  offline = true;
  let response;
  w.handlers.get("fetch")({
    request: new Request("https://irang.example/icons/offline-capture.html"),
    respondWith: (promise) => { response = promise; },
  });
  expect(await (await response).text()).toBe("offline shell");
  w.names.set("unrelated-auth-cache", new Map());
  w.names.set("irang-offline-capture-old", new Map());
  w.handlers.get("activate")({ waitUntil: (promise) => { done = promise; } });
  await done;
  expect([...w.names.keys()]).toEqual(["aro-offline-capture-v1", "unrelated-auth-cache"]);
});

test("legacy drafts move once with unchanged identities and no duplicates", () => {
  // Given
  const store = storage(), first = draft("old"), second = draft("new");
  store.setItem(LEGACY_STORAGE_KEY, JSON.stringify([first]));
  writeDrafts(store, [first, second]);
  // When
  migrateDrafts(store);
  migrateDrafts(store);
  // Then
  expect(readDrafts(store)).toEqual([first, second]);
  expect(store.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  expect(LOCK_NAME).toBe(STORAGE_KEY);
});

test.each(["write", "invalid", "remove"])("failed legacy move retains its source: %s", (failure) => {
  // Given
  const store = storage();
  const value = failure === "invalid" ? "{" : JSON.stringify([draft()]);
  store.setItem(LEGACY_STORAGE_KEY, value);
  if (failure === "write") store.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
  if (failure === "remove") store.removeItem = () => { throw new DOMException("denied", "SecurityError"); };
  // When / Then
  expect(() => migrateDrafts(store)).toThrow();
  expect(store.getItem(LEGACY_STORAGE_KEY)).toBe(value);
});

test("page startup migrates only while holding new and legacy Web Locks", async () => {
  // Given
  const store = storage(), saved = draft("before upgrade");
  store.setItem(LEGACY_STORAGE_KEY, JSON.stringify([saved]));
  const locks = [];
  let grant;
  const granted = new Promise(resolve => { grant = resolve; });
  let rendered;
  const done = new Promise(resolve => { rendered = resolve; });
  const node = () => ({
    addEventListener() {}, replaceChildren() {}, append() {},
    hidden: false, disabled: false, textContent: "",
  });
  const elements = new Map();
  const count = node();
  Object.defineProperty(count, "textContent", { set: rendered });
  elements.set("count", count);
  const context = {
    LOCK_NAME, LEGACY_STORAGE_KEY, migrateDrafts, readDrafts, writeDrafts, prepareFlush, flushDrafts,
    localStorage: store, AbortSignal,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, node());
        return elements.get(id);
      },
      createElement: node, querySelectorAll: () => [], addEventListener() {},
    },
    window: { addEventListener() {} },
    navigator: { locks: { async request(name, options, action) {
      locks.push(name);
      if (name === LOCK_NAME) { await granted; return action({ name }); }
      return options({ name });
    } } },
  };
  const source = readFileSync(new URL("../../public/icons/offline-capture.js", import.meta.url), "utf8");
  // When
  runInNewContext(source.slice(source.indexOf("\n") + 1), context);
  expect(locks).toEqual([LOCK_NAME]);
  expect(store.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  grant();
  await Promise.race([done, new Promise((_, reject) => {
    const signal = AbortSignal.timeout(1000);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
  // Then
  expect(locks).toEqual([LOCK_NAME, LEGACY_STORAGE_KEY]);
  expect(readDrafts(store)).toEqual([saved]);
  expect(store.getItem(LEGACY_STORAGE_KEY)).toBeNull();
});
