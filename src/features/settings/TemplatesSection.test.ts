import { beforeAll, expect, test } from "bun:test";
import type { NoteTemplate } from "@/lib/templates";

const removedId = "00000000-0000-4000-8000-000000000001";
const templates: readonly NoteTemplate[] = [
  { id: removedId, name: "A removable template", body: "Remove this body", isDailyDefault: false,
    createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" },
  { id: "00000000-0000-4000-8000-000000000002", name: "B retained template", body: "Keep this body", isDailyDefault: false,
    createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" },
];
let script: Blob;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [`${import.meta.dir}/TemplatesSection.fixture.tsx`],
    target: "browser", format: "esm",
    define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the template focus fixture");
  const output = build.outputs[0];
  if (!output) throw new Error("Missing template focus bundle");
  script = output;
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Template focus event did not arrive")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

test.each([false, true])("template deletion restores lost focus without stealing a new target (moved=%s)", async (moved) => {
  // Given: the real component, SWR and native dialog, with the post-delete GET held.
  const listRequested = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  let deleted = false;
  let deletes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/") return new Response(`<!doctype html><html><body><div id="root"></div>
        <script>
          window.templateFocusLoaded = new Promise((resolve, reject) => {
            addEventListener("error", event => reject(new Error(event.message)), {once: true});
            addEventListener("template-focus-loaded", resolve, {once: true});
          });
        </script><script type="module" src="/fixture.js"></script></body></html>`, {
        headers: { "content-type": "text/html" },
      });
      if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "application/javascript" } });
      if (path === `/api/templates/${removedId}` && request.method === "DELETE") {
        deleted = true;
        deletes++;
        return Response.json({ ok: true });
      }
      if (path === "/api/templates" && request.method === "GET") {
        if (deleted) {
          listRequested.resolve();
          await releaseList.promise;
        }
        return Response.json({ templates: deleted ? templates.filter(template => template.id !== removedId) : templates });
      }
      return new Response(null, { status: 404 });
    },
  });
  let view: Bun.WebView | undefined;
  try {
    // Never attach to a user's browser. BUN_CHROME_PATH supports nonstandard installs.
    view = new Bun.WebView({ backend: { type: "chrome", url: false, argv: ["--no-sandbox"] }, dataStore: "ephemeral" });
    await bounded(view.navigate(server.url.href));
    await bounded(view.evaluate("window.templateFocusLoaded"));
    await bounded(view.evaluate("window.templateFocusTest.ready"));
    const opener = await view.evaluate<string>("window.templateFocusTest.deleteSelector");
    await bounded(view.click(opener));
    await bounded(view.evaluate("window.templateFocusTest.opened"));
    await bounded(view.click("dialog[open] footer button:last-child"));
    await bounded(listRequested.promise);
    await bounded(view.evaluate("window.templateFocusTest.closed"));
    expect(deletes).toBe(1);
    expect(await view.evaluate<{ readonly rows: number; readonly openerFocused: boolean }>(`({
      rows: document.querySelectorAll('section[aria-labelledby="settings-templates"] li').length,
      openerFocused: document.activeElement === document.querySelector(${JSON.stringify(opener)})
    })`)).toEqual({ rows: 2, openerFocused: true });
    if (moved) await view.evaluate("document.getElementById('other-control').focus()");

    // When: revalidation removes the opener after the modal has already closed.
    releaseList.resolve();
    await bounded(view.evaluate("window.templateFocusTest.removed"));

    // Then: recover to Add template only if the user has not focused another control.
    const expected = moved ? "#other-control" : 'section[aria-labelledby="settings-templates"] button';
    expect(await view.evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(expected)})`)).toBe(true);
    expect(await view.evaluate<number>('document.querySelectorAll(\'section[aria-labelledby="settings-templates"] li\').length')).toBe(1);
  } finally {
    releaseList.resolve();
    view?.close();
    await server.stop(true);
  }
}, 30_000);
