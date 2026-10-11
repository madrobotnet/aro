/**
 * Owned-environment HTTP proof. Invoke only with IMPORT_QA_URL and TEST_DATABASE_URL
 * pointing at a disposable lane server/database; the database safety guard is mandatory.
 */
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { createSession } from "@/server/auth/session";
import { closeDb, connectTestDatabase, resetData } from "@/server/test/db";

const base = process.env.IMPORT_QA_URL;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Set a loopback IMPORT_QA_URL");
connectTestDatabase();
await resetData();
const session = await createSession({ passwordHash: "disposable-http-qa", userAgent: "aro-import-qa", ip: "127.0.0.1" });
const cookie = `sb_session=${session.token}`;
const previewSchema = z.object({
  digest: z.string(), canCommit: z.boolean(), notes: z.array(z.object({ title: z.string() })),
  attachments: z.number(), warnings: z.array(z.object({ code: z.string() })),
});
const receiptSchema = z.object({
  status: z.literal("imported"), notes: z.array(z.object({ id: z.string(), title: z.string() })), attachments: z.number(),
});

async function post(route: string, filename: string, bytes: Uint8Array, extra: Record<string, string> = {}, auth = cookie) {
  const response = await fetch(`${base}/api/import/${route}`, {
    method: "POST",
    headers: {
      cookie: auth, origin: base ?? "", "content-type": "application/octet-stream",
      "x-import-filename": encodeURIComponent(filename), ...extra,
    },
    body: new Blob([Uint8Array.from(bytes)]),
  });
  const text = await response.text();
  console.log(JSON.stringify({
    scenario: `${route}:${filename}`, status: response.status,
    headers: Object.fromEntries(response.headers), body: text,
  }));
  const body: unknown = JSON.parse(text);
  return { status: response.status, body };
}

try {
  const bytes = zipSync({
    "Start.md": strToU8("---\naliases: [Beginning]\ntags: [work]\n---\n[[Target]] ![image](files/pixel.png)\n`[[Target]]`"),
    "Target.md": strToU8("Target body"),
    "files/pixel.png": strToU8("synthetic-png-bytes"),
  });
  assert.equal((await post("preview", "vault.zip", bytes, {}, "")).status, 401);
  assert.equal((await post("preview", "vault.zip", bytes, {}, "sb_session=invalid")).status, 401);
  assert.equal((await post("preview", "vault.zip", bytes, { origin: "https://other.example" })).status, 403);
  const viewed = await post("preview", "vault.zip", bytes);
  assert.equal(viewed.status, 200);
  const preview = previewSchema.parse(viewed.body);
  assert.equal(preview.canCommit, true);
  assert.equal(preview.notes.length, 2);
  assert.equal(preview.attachments, 1);
  assert.equal((await post("commit", "vault.zip", bytes)).status, 400);
  assert.equal((await post("commit", "vault.zip", bytes, {
    "x-import-confirm": "true", "x-import-digest": "0".repeat(64),
  })).status, 409);
  const committed = await post("commit", "vault.zip", bytes, {
    "x-import-confirm": "true", "x-import-digest": preview.digest,
  });
  assert.equal(committed.status, 201);
  const receipt = receiptSchema.parse(committed.body);
  assert.equal(receipt.notes.length, 2);
  assert.equal(receipt.attachments, 1);
  const start = receipt.notes.find((note) => note.title === "Start");
  assert.ok(start);
  const noteResponse = await fetch(`${base}/api/notes/${start.id}`, { headers: { cookie } });
  const noteRaw: unknown = await noteResponse.json();
  const note = z.object({ note: z.object({ body: z.string(), aliases: z.array(z.string()), tags: z.array(z.string()) }) }).parse(noteRaw);
  assert.equal(noteResponse.status, 200);
  assert.ok(note.note.aliases.includes("Beginning"));
  assert.ok(note.note.tags.includes("work"));
  assert.ok(note.note.body.includes("`[[Target]]`"));
  const href = /\/api\/attachments\/[a-f0-9-]{36}/.exec(note.note.body)?.[0];
  assert.ok(href);
  const file = await fetch(`${base}${href}`, { headers: { cookie } });
  const fileText = await file.text();
  assert.equal(file.status, 200);
  assert.equal(fileText, "synthetic-png-bytes");
  console.log(JSON.stringify({ scenario: "read-imported-note-and-attachment", status: file.status, headers: Object.fromEntries(file.headers), note: noteRaw, body: fileText }));
  assert.equal((await post("commit", "vault.zip", bytes, {
    "x-import-confirm": "true", "x-import-digest": preview.digest,
  })).status, 409);
  const repeat = previewSchema.parse((await post("preview", "vault.zip", bytes)).body);
  assert.equal(repeat.canCommit, false);
  assert.equal((await post("preview", "unsafe.zip", zipSync({ "../escape.md": strToU8("bad") }))).status, 400);
  const warning = previewSchema.parse((await post("preview", "Missing.md", strToU8("![gone](missing.png)"))).body);
  assert.ok(warning.warnings.length > 0);
  console.log("HTTP_IMPORT_QA_PASS");
} finally {
  await closeDb();
}
