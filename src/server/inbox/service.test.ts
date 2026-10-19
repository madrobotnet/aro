import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { query, queryOne } from "@/server/db";
import { setJevForTests } from "@/server/jev/client";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";
import { captureInbox, enrichInboxItem, listInbox, promoteInbox, suggestInbox } from "./service";
import { URL_FAILED_MARKER, URL_PENDING_MARKER } from "@/lib/inbox-url-status";
import { CAPTURE_TITLE } from "@/server/i18n/copy";

connectTestDatabase();

beforeEach(async () => {
  setJevForTests(undefined);
  await resetData();
});

afterAll(async () => {
  setJevForTests(undefined);
  await closeDb();
});

describe("capture and enrichment", () => {
  test("Postgres DTOs clean legacy links and preserve literal captures before truncation", async () => {
    const body = `">' <nav>menu</nav><p>지식 &bull; 연결 &amp; 기록</p><script>noise()</script> <p>두 번째 문장</p>`;
    const link = await captureInbox({ title: "Legacy", text: body, url: "https://example.com/legacy" });
    expect(link.preview).toBe("지식 • 연결 & 기록 두 번째 문장");
    expect(link.homePreview).toBe(link.preview);
    const literal = await captureInbox({ title: "Syntax", text: body });
    expect(literal.preview).toBe(body);
    const repeated = await captureInbox({ text: "title only" });
    expect(repeated.preview).toBe("");
    const long = await captureInbox({ title: "Long", text: "a".repeat(300) });
    expect(long.preview).toBe(`${"a".repeat(139)}…`);
    expect(long.homePreview).toBe(`${"a".repeat(279)}…`);
    const stored = (await listInbox()).items.find(item => item.id === link.id);
    expect(stored?.preview).toBe(link.preview);
    expect(stored?.body).toBe(link.body);
  });

  test("persists text and URL before a URL transport failure and records visible failure", async () => {
    setJevForTests(null);
    const captured = await captureInbox({ title: "자료", text: "내 메모", url: "https://example.com/a" });

    expect(captured.body).toContain("내 메모");
    expect((await listInbox()).items.map((item) => item.id)).toContain(captured.id);

    await enrichInboxItem(captured.id, {
      resolve: async () => ["93.184.216.34"],
      fetch: async () => { throw new TypeError("network down"); },
    });

    const stored = (await listInbox()).items[0]!;
    expect(stored.body).toContain("내 메모");
    expect(stored.body).toContain(URL_FAILED_MARKER);
    expect(stored.suggestions?.status).toBe("unavailable");
  });

  test("uses neutral markers and localized fallback titles while enriching legacy rows", async () => {
    setJevForTests(null);
    const captured = await captureInbox({ url: "not a url" }, "en");
    expect(captured.title).toBe(CAPTURE_TITLE.link.en);
    expect(captured.body).toBe(URL_PENDING_MARKER);
    const legacy = await queryOne<{ id: string }>(`INSERT INTO inbox_items (title,body,source,url)
      VALUES ('legacy','original\n\n> URL 내용을 가져오는 중입니다.','url','https://example.com/legacy') RETURNING id`);
    await enrichInboxItem(legacy!.id, {
      resolve: async () => ["93.184.216.34"],
      fetch: async () => new Response("fetched", { headers: { "content-type": "text/plain" } }),
    }, "en");
    const stored = (await listInbox()).items.find((item) => item.id === legacy!.id)!;
    expect(stored.body).toBe("original\n\nfetched");
    expect(stored.url).toBe("https://example.com/legacy");
  });

  test("keeps capture usable when Jev throws", async () => {
    setJevForTests(new TypeSafeClient({
      apiKey: "test",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch: async () => { throw new Error("Jev unavailable"); },
    }));
    const captured = await captureInbox({ text: "실패해도 남는 기록" });
    const suggested = await suggestInbox(captured.id);

    expect(suggested.body).toBe("실패해도 남는 기록");
    expect(suggested.suggestions).toEqual({ status: "failed", tags: [], kind: null, duplicateOf: null });
    expect((await listInbox()).count).toBe(1);
  });

  test("maps legacy suggestion JSON without failing the inbox list", async () => {
    await query(
      `INSERT INTO inbox_items (title,body,source,suggestions)
       VALUES ('이전 항목','본문','api',$1::jsonb)`,
      [JSON.stringify({ tags: [{ tag: "idea", noul: 0.8 }, null], classification: { choice: "idea", probability: 0.7 } })],
    );

    const item = (await listInbox()).items[0]!;
    expect(item.suggestions?.status).toBe("ready");
    expect(item.suggestions?.tags).toEqual([{ tag: "idea", probability: 0.8 }]);
    expect(item.suggestions?.kind).toEqual({ choice: "idea", confidence: 0.7 });
  });
});

describe("atomic inbox promotion", () => {
  test("concurrent repeated promotion creates one note and transfers attachment ownership", async () => {
    const item = await captureInbox({ title: "승격", text: "본문" });
    await query(
      `INSERT INTO attachments (inbox_item_id,filename,mime,size_bytes,storage_key)
       VALUES ($1,'file.txt','text/plain',4,'test/file.txt')`,
      [item.id],
    );

    const [first, second] = await Promise.all([promoteInbox(item.id), promoteInbox(item.id)]);

    expect(second.id).toBe(first.id);
    const noteCount = await queryOne<{ count: number }>("SELECT count(*)::int AS count FROM notes");
    expect(noteCount?.count).toBe(1);
    const attachment = await queryOne<{ note_id: string | null; inbox_item_id: string | null }>(
      "SELECT note_id,inbox_item_id FROM attachments LIMIT 1",
    );
    expect(attachment).toEqual({ note_id: first.id, inbox_item_id: null });
  });

  test("suggestions remain proposals and are not copied to a promoted note", async () => {
    const item = await captureInbox({ title: "제안", text: "내용" });
    await query(
      "UPDATE inbox_items SET suggestions=$2::jsonb WHERE id=$1",
      [item.id, JSON.stringify({ status: "ready", tags: [{ tag: "idea", probability: 0.99 }], kind: null, duplicateOf: null })],
    );

    const note = await promoteInbox(item.id);
    expect(note.tags).toEqual([]);
    expect(note.body).toBe("내용");
  });

  test("never promotes new or legacy URL status markers", async () => {
    const current = await captureInbox({ title: "current", text: "keep", url: "https://example.com" }, "en");
    expect((await promoteInbox(current.id, {}, "en")).body).toBe("keep");
    const legacy = await queryOne<{ id: string }>(`INSERT INTO inbox_items (title,body,source,url)
      VALUES ('legacy','keep legacy\n\n> URL 내용을 가져오지 못했습니다. 원문 링크는 보존되었습니다.','url','https://example.com/legacy') RETURNING id`);
    const note = await promoteInbox(legacy!.id, {}, "en");
    expect(note.body).toBe("keep legacy");
    expect(note.sourceUrl).toBe("https://example.com/legacy");
  });
});
