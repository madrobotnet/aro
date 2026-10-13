import { afterEach, describe, expect, test } from "bun:test";
import type { Note } from "@/lib/types";
import { mergeTaskToggle, NoteDraftController, type EditableNote } from "./note-draft";
import { applySavedTaskToggle, forgetNoteDraft, getNoteDraft, hasUnsavedNoteDrafts } from "./draft-store";

const note = (body = "old"): Note => ({
  id: "00000000-0000-4000-8000-000000000001",
  title: "제목",
  body,
  tags: [],
  aliases: [],
  purgeAt: null,
  excerpt: body,
  pinned: false,
  archived: false,
  dailyDate: null,
  sourceUrl: null,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => forgetNoteDraft(note().id));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("NoteDraftController", () => {
  test("merges a tasks-page toggle into a dirty retained draft during an in-flight save", async () => {
    // Given
    const saving = deferred<Note>();
    const sent: string[] = [];
    const controller = getNoteDraft(note("- [ ] 작업"), async (_id, value) => {
      sent.push(value.body);
      return sent.length === 1 ? saving.promise : note(value.body);
    });
    controller.update({ body: "- [ ] 작업\n한글 입력" });
    const inFlight = controller.flush();
    // When
    const merged = applySavedTaskToggle(note("- [x] 작업"), { line: 1, expectedText: "작업", done: true });
    controller.update({ body: controller.getSnapshot().body + " 계속" });
    saving.resolve(note(sent[0]));
    await Promise.all([inFlight, merged]);
    // Then
    expect(sent).toEqual(["- [ ] 작업\n한글 입력", "- [x] 작업\n한글 입력 계속"]);
    expect(controller.getSnapshot().body).toBe("- [x] 작업\n한글 입력 계속");
    expect(controller.getSnapshot().state).toBe("saved");
  });

  test("retains an unsaved draft when the same note is reopened", () => {
    const first = getNoteDraft(note(), async () => note());
    first.update({ body: "local draft" });

    const reopened = getNoteDraft(note("stale server text"), async () => note());

    expect(reopened).toBe(first);
    expect(reopened.getSnapshot().body).toBe("local draft");
    expect(hasUnsavedNoteDrafts()).toBe(true);
  });

  test("clears the unload warning condition after a successful flush", async () => {
    const controller = getNoteDraft(note(), async (_id, value) => note(value.body));
    controller.update({ body: "saved text" });

    await controller.flush();

    expect(hasUnsavedNoteDrafts()).toBe(false);
  });

  test("adopts canonical metadata returned by a successful save", async () => {
    const controller = new NoteDraftController(note(), async () => ({
      ...note("#inline"),
      title: "새 제목",
      tags: ["inline"],
      aliases: ["이전 제목"],
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    controller.update({ title: " 새 제목 ", body: "#inline" });

    const saved = await controller.flush();

    expect(controller.getSnapshot()).toMatchObject({
      title: "새 제목", tags: ["inline"], aliases: ["이전 제목"], state: "saved",
    });
    expect(saved).toBe(true);
  });

  test("reports a failed flush so destructive actions can stop", async () => {
    const controller = new NoteDraftController(note(), async () => { throw new Error("offline"); });
    controller.update({ body: "retained draft" });

    const saved = await controller.flush();

    expect(saved).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ body: "retained draft", state: "failed" });
  });

  test("keeps server-added aliases when a newer body edit is queued", async () => {
    const first = Promise.withResolvers<Note>();
    const writes: EditableNote[] = [];
    const controller = new NoteDraftController(note(), async (_id, value) => {
      writes.push(value);
      return writes.length === 1 ? first.promise : { ...note(value.body), ...value };
    });
    controller.update({ title: "renamed" });
    const saving = controller.flush();
    controller.update({ body: "newer body" });

    first.resolve({ ...note(), title: "renamed", aliases: ["제목"] });
    await saving;

    expect(writes[1]).toMatchObject({ body: "newer body", aliases: ["제목"] });
  });

  test("serializes writes and saves edits made while the first write is pending", async () => {
    const first = deferred<Note>();
    const second = deferred<Note>();
    const secondStarted = deferred<void>();
    const writes: EditableNote[] = [];
    const controller = new NoteDraftController(note(), async (_id, value) => {
      writes.push(value);
      if (writes.length === 2) secondStarted.resolve();
      return writes.length === 1 ? first.promise : second.promise;
    });

    controller.update({ body: "first" });
    const saving = controller.flush();
    expect(writes.map((write) => write.body)).toEqual(["first"]);

    controller.update({ body: "latest" });
    first.resolve({ ...note("first"), updatedAt: "2026-01-02T00:00:00.000Z" });
    await secondStarted.promise;
    expect(writes.map((write) => write.body)).toEqual(["first", "latest"]);

    second.resolve({ ...note("latest"), updatedAt: "2026-01-03T00:00:00.000Z" });
    await saving;
    expect(controller.getSnapshot()).toMatchObject({ body: "latest", state: "saved", updatedAt: "2026-01-03T00:00:00.000Z" });
  });

  test("a restored version replaces a dirty draft and leaves nothing to autosave", async () => {
    const writes: string[] = [];
    const controller = new NoteDraftController(note(), async (_id, value) => {
      writes.push(value.body);
      return note(value.body);
    });
    controller.update({ body: "unsaved local edit" });

    controller.replace({ ...note("restored body"), updatedAt: "2026-01-05T00:00:00.000Z" });

    expect(controller.getSnapshot()).toMatchObject({ body: "restored body", state: "saved", updatedAt: "2026-01-05T00:00:00.000Z" });
    expect(await controller.flush()).toBe(true);
    expect(writes).toEqual([]);
  });

  test("a save acknowledged after a restore cannot bring back the old text", async () => {
    const first = Promise.withResolvers<Note>();
    const writes: string[] = [];
    const controller = new NoteDraftController(note(), async (_id, value) => {
      writes.push(value.body);
      return writes.length === 1 ? first.promise : { ...note(value.body), updatedAt: "2026-01-06T00:00:00.000Z" };
    });
    controller.update({ body: "in flight" });
    const saving = controller.flush();

    controller.replace({ ...note("restored body"), updatedAt: "2026-01-05T00:00:00.000Z" });
    first.resolve({ ...note("in flight"), updatedAt: "2026-01-04T00:00:00.000Z" });
    await saving;

    expect(writes).toEqual(["in flight", "restored body"]);
    expect(controller.getSnapshot()).toMatchObject({ body: "restored body", state: "saved" });
  });

  test("does not hydrate over a dirty draft and retries the retained value", async () => {
    let fail = true;
    const offline = new Error("offline");
    const writes: string[] = [];
    const controller = new NoteDraftController(note(), async (_id, value) => {
      writes.push(value.body);
      if (fail) throw offline;
      return { ...note(value.body), updatedAt: "2026-01-04T00:00:00.000Z" };
    });
    controller.update({ body: "local" });
    controller.hydrate({ ...note("stale"), updatedAt: "2026-01-02T00:00:00.000Z" });
    await controller.flush();
    expect(controller.getSnapshot()).toMatchObject({ body: "local", state: "failed" });
    // The thrown failure is kept as-is so its message can re-render after a language switch.
    expect(controller.getSnapshot().error).toBe(offline);

    fail = false;
    await controller.retry();
    expect(writes).toEqual(["local", "local"]);
    expect(controller.getSnapshot()).toMatchObject({ body: "local", state: "saved", error: null });

    controller.hydrate({ ...note("older server body"), updatedAt: "2026-01-03T00:00:00.000Z" });
    expect(controller.getSnapshot().body).toBe("local");
  });
});

describe("mergeTaskToggle", () => {
  const body = "# Day\n- [ ] call Bob\n- [x] ship\n";
  const check = { line: 2, expectedText: "call Bob", done: true };

  test("a clean draft in preview adopts the server note", () => {
    expect(mergeTaskToggle({ state: "saved", body }, check, true)).toEqual({ kind: "replace" });
  });

  test.each(["dirty", "saving", "failed"] as const)("a %s draft gets the toggle applied to its own body", (state) => {
    const typed = "# Day\n- [ ] call Bob\n- [x] ship\nnew typing";
    expect(mergeTaskToggle({ state, body: typed }, check, true)).toEqual({ kind: "update", body: "# Day\n- [x] call Bob\n- [x] ship\nnew typing" });
  });

  test("back in the editor even a clean draft is updated in place instead of replaced", () => {
    expect(mergeTaskToggle({ state: "saved", body }, check, false)).toEqual({ kind: "update", body: "# Day\n- [x] call Bob\n- [x] ship\n" });
  });

  test("a task moved by typed lines above it still receives the toggle", () => {
    const moved = "# Day\nintro\n\n- [ ] call Bob\n- [x] ship\n";
    expect(mergeTaskToggle({ state: "dirty", body: moved }, check, false)).toEqual({ kind: "update", body: "# Day\nintro\n\n- [x] call Bob\n- [x] ship\n" });
  });

  test("keeps the draft when it already has the state, the task text changed, or the match is ambiguous", () => {
    expect(mergeTaskToggle({ state: "dirty", body: "# Day\n- [x] call Bob\n" }, check, false)).toEqual({ kind: "keep" });
    expect(mergeTaskToggle({ state: "dirty", body: "# Day\n- [ ] call Robert\n" }, check, false)).toEqual({ kind: "keep" });
    expect(mergeTaskToggle({ state: "dirty", body: "x\n\n- [ ] call Bob\n- [ ] call Bob\n" }, check, false)).toEqual({ kind: "keep" });
  });

  test("a toggle merged during an in-flight autosave is sent by the follow-up save", async () => {
    const first = Promise.withResolvers<Note>();
    const writes: string[] = [];
    const controller = new NoteDraftController(note(body), async (_id, value) => {
      writes.push(value.body);
      return writes.length === 1 ? first.promise : note(value.body);
    });
    controller.update({ body: `${body}typed` });
    const saving = controller.flush();

    const merge = mergeTaskToggle(controller.getSnapshot(), check, false);
    if (merge.kind === "update") controller.update({ body: merge.body });
    first.resolve(note(`${body}typed`));
    await saving;

    expect(writes).toEqual([`${body}typed`, "# Day\n- [x] call Bob\n- [x] ship\ntyped"]);
    expect(controller.getSnapshot()).toMatchObject({ body: "# Day\n- [x] call Bob\n- [x] ship\ntyped", state: "saved" });
  });
});
