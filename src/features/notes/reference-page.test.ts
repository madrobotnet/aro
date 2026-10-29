import { expect, test } from "bun:test";

// Bun module replacements are process-global. Isolate this server-page boundary
// so its session/lookup doubles cannot leak into the real database suites.
const probe = `
import { mock } from "bun:test";
const input = JSON.parse(process.env.ARO_REFERENCE_CASE);
const events = [];
class Redirect extends Error {
  constructor(path) { super("redirect"); this.path = path; }
}
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation, redirect(path) { throw new Redirect(path); },
}));
mock.module("@/server/auth/session", () => ({
  async getSession() { events.push({ type: "auth" }); return input.auth ? { id: "session" } : null; },
}));
mock.module("@/server/notes/reference", () => ({
  async findNoteReference(title) {
    events.push({ type: "lookup", title });
    if (input.failure) throw new Error("synthetic lookup failure");
    return input.note ?? null;
  },
}));
const { default: Page } = await import("./src/app/(app)/notes/by-title/page.tsx");
let result;
try {
  const element = await Page({ searchParams: Promise.resolve({ title: input.title }) });
  result = { kind: "state", state: element.props.state, events };
} catch (error) {
  if (!(error instanceof Redirect)) throw error;
  result = { kind: "redirect", path: error.path, events };
}
console.log(JSON.stringify(result));
`;

const cases = [
  {
    name: "authenticates before lookup",
    input: { auth: false, title: "Existing", note: { id: "note-id", title: "Existing" } },
    expected: { kind: "redirect", path: "/login", events: [{ type: "auth" }] },
  },
  ...[undefined, " \t ", "x".repeat(301), ["ambiguous", "title"]].map((title, index) => ({
    name: `rejects invalid title ${index} without lookup`,
    input: { auth: true, title },
    expected: { kind: "state", state: { kind: "invalid" }, events: [{ type: "auth" }] },
  })),
  {
    name: "renders explicit creation only after a successful missing lookup",
    input: { auth: true, title: "  Missing  " },
    expected: { kind: "state", state: { kind: "missing", title: "Missing" }, events: [{ type: "auth" }, { type: "lookup", title: "Missing" }] },
  },
  {
    name: "redirects an existing reference",
    input: { auth: true, title: "Existing", note: { id: "note-id", title: "Existing" } },
    expected: { kind: "redirect", path: "/notes/note-id", events: [{ type: "auth" }, { type: "lookup", title: "Existing" }] },
  },
  {
    name: "does not expose creation after lookup failure",
    input: { auth: true, title: "Broken", failure: true },
    expected: { kind: "state", state: { kind: "failed" }, events: [{ type: "auth" }, { type: "lookup", title: "Broken" }] },
  },
];

for (const scenario of cases) test(scenario.name, async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", probe], {
    cwd: process.cwd(),
    env: { ...process.env, ARO_REFERENCE_CASE: JSON.stringify(scenario.input) },
    stdout: "pipe", stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);

  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual(scenario.expected);
});
