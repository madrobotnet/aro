import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { seedRelations, SQLiteFixture } from "./test-fixture";

test("provides every persisted entity and declared SQLite index", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const tables = [
    "aro_schema_migrations", "users", "sessions", "auth_login_failures", "notes", "links",
    "unresolved_links", "inbox_items", "attachments", "chat_threads", "chat_messages",
    "installation_settings", "ai_connections", "ai_auth_attempts", "attachment_cleanup",
    "note_revisions", "note_templates", "note_semantic_index", "note_passages", "chat_requests", "capture_requests",
    "agent_tokens", "agent_proposals", "agent_requests", "agent_activity",
    "note_shares", "oauth_clients", "oauth_grants", "oauth_codes", "oauth_refresh_tokens", "oauth_rate_limits",
  ];
  const indexes = [
    "sessions_token_hash_uidx", "sessions_user_idx", "auth_login_failures_client_time_idx",
    "notes_active_updated_idx", "notes_daily_date_uidx", "links_from_note_idx", "links_to_note_idx",
    "unresolved_links_target_idx", "inbox_open_idx", "inbox_promoted_note_idx",
    "attachments_note_idx", "attachments_inbox_idx", "chat_messages_thread_idx",
    "ai_connections_owner_idx", "ai_auth_attempts_expiry_idx", "ai_auth_attempts_scope_idx",
    "note_revisions_note_created_idx", "notes_trash_purge_idx", "inbox_snoozed_idx",
    "note_templates_daily_default_uidx", "note_passages_model_idx", "chat_requests_thread_idx",
    "chat_requests_assistant_idx",
    "agent_proposals_status_idx", "agent_activity_time_idx",
    "note_shares_note_idx", "oauth_grants_owner_idx", "oauth_refresh_grant_idx", "agent_tokens_grant_idx",
  ];
  // When
  const actualTables = db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table'").map(row => row.name);
  const actualIndexes = db.all<{ name: string }>(
    "SELECT name FROM sqlite_schema WHERE type='index' AND name NOT GLOB 'sqlite_*'",
  ).map(row => row.name);
  // Then
  expect(actualTables.sort()).toEqual(tables.sort());
  expect(actualIndexes.sort()).toEqual(indexes.sort());
});

test("preserves link uniqueness self-link checks and revision reason constraints", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first, second } = seedRelations(db);
  // When / Then
  db.run("INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [first, second]);
  expect(() => db.run("INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [first, second])).toThrow();
  expect(() => db.run("INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [first, first])).toThrow();
  expect(() => db.run("INSERT INTO note_revisions(note_id,title,body,reason) VALUES (?,'a','b','invalid')", [first])).toThrow();
  for (const reason of ["edit", "restore", "merge", "link-mention", "task-toggle"]) {
    db.run("INSERT INTO note_revisions(note_id,title,body,reason) VALUES (?,'a','b',?)", [first, reason]);
  }
  db.run("INSERT INTO unresolved_links VALUES (?, 'Missing')", [first]);
  expect(() => db.run("INSERT INTO unresolved_links VALUES (?, 'Missing')", [first])).toThrow();
  expect(db.get("SELECT count(*) AS total FROM note_revisions")).toEqual({ total: 5n });
});

test("enforces daily note uniqueness only while active including failed restore", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first, second } = seedRelations(db);
  db.run("UPDATE notes SET daily_date='2026-10-11' WHERE id=?", [first]);
  expect(() => db.run("UPDATE notes SET daily_date='2026-10-11' WHERE id=?", [second])).toThrow();
  db.run("UPDATE notes SET deleted_at='2026-10-11T00:00:00.000000Z' WHERE id=?", [first]);
  db.run("UPDATE notes SET daily_date='2026-10-11' WHERE id=?", [second]);
  // When / Then
  expect(() => db.run("UPDATE notes SET deleted_at=NULL WHERE id=?", [first])).toThrow();
  expect(db.get("SELECT id FROM notes WHERE daily_date='2026-10-11' AND deleted_at IS NULL")).toEqual({ id: second });
});

test("enforces singleton settings template names and one daily template", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { owner } = seedRelations(db);
  db.run("INSERT INTO installation_settings(owner_id) VALUES (?)", [owner]);
  db.run("INSERT INTO note_templates(name,body,is_daily_default) VALUES ('Daily','body',1)");
  // When / Then
  expect(() => db.run("INSERT INTO installation_settings(owner_id) VALUES (?)", [owner])).toThrow();
  expect(() => db.run("UPDATE installation_settings SET singleton=0")).toThrow();
  expect(() => db.run("INSERT INTO note_templates(name,body) VALUES ('Daily','other')")).toThrow();
  expect(() => db.run("INSERT INTO note_templates(name,body,is_daily_default) VALUES ('Second','body',1)")).toThrow();
  db.run("INSERT INTO note_templates(name,body) VALUES ('Other','body')");
  expect(db.get("SELECT count(*) AS total FROM note_templates")).toEqual({ total: 2n });
});

test("preserves blobs token uniqueness and all owner cascades", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { owner } = seedRelations(db);
  const token = new Uint8Array([0, 127, 255]);
  const insert = "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES (?,?,'2027-01-01T00:00:00.000000Z')";
  db.run(insert, [owner, token]);
  expect(db.get("SELECT token_hash FROM sessions")?.token_hash).toEqual(token);
  expect(() => db.run(insert, [owner, token])).toThrow();
  db.run("INSERT INTO installation_settings(owner_id) VALUES (?)", [owner]);
  db.run("INSERT INTO ai_connections(owner_id,purpose,name,connection) VALUES (?,'chat','Local','{}')", [owner]);
  // When
  db.run("DELETE FROM users WHERE id=?", [owner]);
  // Then
  for (const table of ["sessions", "installation_settings", "ai_connections"]) {
    expect(db.get(`SELECT count(*) AS total FROM ${table}`)).toEqual({ total: 0n });
  }
});

test("rejects orphan references for every foreign key edge", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first, thread } = seedRelations(db);
  const missing = randomUUID();
  const attempts = [
    ["INSERT INTO sessions(user_id,token_hash,expires_at) VALUES (?,x'01','2027-01-01T00:00:00.000000Z')", [missing]],
    ["INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [missing, first]],
    ["INSERT INTO links(from_note_id,to_note_id) VALUES (?,?)", [first, missing]],
    ["INSERT INTO unresolved_links VALUES (?,'Missing')", [missing]],
    ["UPDATE inbox_items SET promoted_note_id=?", [missing]],
    ["INSERT INTO attachments(note_id,filename,mime,size_bytes,storage_key) VALUES (?,'f','m',1,'k')", [missing]],
    ["INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'f','m',1,'k')", [missing]],
    ["INSERT INTO chat_messages(thread_id,role,content) VALUES (?,'user','body')", [missing]],
    ["INSERT INTO installation_settings(owner_id) VALUES (?)", [missing]],
    ["INSERT INTO ai_connections(owner_id,purpose,name,connection) VALUES (?,'chat','name','{}')", [missing]],
    ["INSERT INTO note_revisions(note_id,title,body) VALUES (?,'t','b')", [missing]],
    ["INSERT INTO note_semantic_index(note_id,model_id,source_hash) VALUES (?,'m','h')", [missing]],
    ["INSERT INTO note_passages VALUES (?,'m','h',0,'h',1,1,'body',?)", [missing, JSON.stringify(Array(768).fill(0))]],
    ["INSERT INTO chat_requests(id,thread_id,content) VALUES (?,?,'body')", [randomUUID(), missing]],
    ["INSERT INTO chat_requests(id,thread_id,content,assistant_id) VALUES (?,?,'body',?)", [randomUUID(), thread, missing]],
  ] as const;
  // When / Then
  for (const [sql, params] of attempts) expect(() => db.run(sql, params)).toThrow("FOREIGN KEY constraint failed");
});

test("cascades note dependencies and nulls promoted inbox while retaining loose attachments", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { first, second, inbox } = seedRelations(db);
  db.run("INSERT INTO links(from_note_id,to_note_id) VALUES (?,?),(?,?)", [first, second, second, first]);
  db.run("INSERT INTO unresolved_links VALUES (?,'Missing')", [first]);
  db.run("INSERT INTO note_revisions(note_id,title,body) VALUES (?,'old','body')", [first]);
  db.run("INSERT INTO note_semantic_index(note_id,model_id,source_hash) VALUES (?,'m','h')", [first]);
  db.run("INSERT INTO note_passages VALUES (?,'m','h',0,'heading',1,1,'content',?)",
    [first, JSON.stringify(Array(768).fill(0))]);
  db.run("UPDATE inbox_items SET promoted_note_id=? WHERE id=?", [first, inbox]);
  const insert = "INSERT INTO attachments(note_id,inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,?,'f','m',1,?)";
  db.run(insert, [first, null, "note"]);
  db.run(insert, [first, inbox, "both"]); // PostgreSQL v2 deliberately removed the XOR constraint.
  db.run(insert, [null, inbox, "inbox"]);
  db.run(insert, [null, null, "loose"]);
  // When
  db.run("DELETE FROM notes WHERE id=?", [first]);
  // Then
  for (const table of ["links", "unresolved_links", "note_revisions", "note_semantic_index", "note_passages"]) {
    expect(db.get(`SELECT count(*) AS total FROM ${table}`)).toEqual({ total: 0n });
  }
  expect(db.get("SELECT promoted_note_id FROM inbox_items")).toEqual({ promoted_note_id: null });
  expect(db.all("SELECT storage_key FROM attachments ORDER BY storage_key")).toEqual([{ storage_key: "inbox" }, { storage_key: "loose" }]);
  expect(db.get("SELECT id FROM notes")).toEqual({ id: second });
});

test("cascades inbox attachments without manufacturing filesystem cleanup", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { inbox } = seedRelations(db);
  db.run("INSERT INTO attachments(inbox_item_id,filename,mime,size_bytes,storage_key) VALUES (?,'f','m',1,'key')", [inbox]);
  // When
  db.transaction(tx => {
    tx.run("INSERT INTO attachment_cleanup SELECT storage_key FROM attachments WHERE inbox_item_id=?", [inbox]);
    tx.run("DELETE FROM inbox_items WHERE id=?", [inbox]);
  });
  // Then
  expect(db.all("SELECT * FROM attachments")).toEqual([]);
  expect(db.all("SELECT * FROM attachment_cleanup")).toEqual([{ storage_key: "key" }]);
});

test("preserves chat request uniqueness message cascade and thread cascade", () => {
  // Given
  using fixture = new SQLiteFixture();
  const db = fixture.open();
  const { thread } = seedRelations(db);
  const message = randomUUID();
  const request = randomUUID();
  db.run("INSERT INTO chat_messages(id,thread_id,role,content) VALUES (?,?,'assistant','body')", [message, thread]);
  db.run("INSERT INTO chat_requests VALUES (?,?,'question',?)", [request, thread, message]);
  expect(() => db.run("INSERT INTO chat_requests VALUES (?,?,'other',NULL)", [request, thread])).toThrow();
  // When
  db.run("DELETE FROM chat_messages WHERE id=?", [message]);
  // Then
  expect(db.all("SELECT * FROM chat_requests")).toEqual([]);
  db.run("INSERT INTO chat_requests VALUES (?,?,'question',NULL)", [request, thread]);
  db.run("INSERT INTO chat_messages(thread_id,role,content) VALUES (?,'user','body')", [thread]);
  db.run("DELETE FROM chat_threads WHERE id=?", [thread]);
  expect(db.all("SELECT * FROM chat_requests")).toEqual([]);
  expect(db.all("SELECT * FROM chat_messages")).toEqual([]);
});
