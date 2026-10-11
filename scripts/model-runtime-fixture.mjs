// Test-only native-process stand-in. It receives the actual fixed llama-server argv.
import { basename } from "node:path";
const mode = basename(process.argv[1]);
if (mode.startsWith("fail-")) process.exit(17);
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
if (mode.startsWith("stubborn-")) process.on("SIGTERM", () => {});
const server = Bun.serve({
  hostname: args[args.indexOf("--host") + 1], port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      if (mode.startsWith("cancel-")) {
        await fetch(`http://127.0.0.1:${mode.split("-")[1]}/started`);
        return new Response(null, { status: 503 });
      }
      return Response.json({ status: mode.startsWith("stall-") ? "loading" : "ok" },
        { status: mode.startsWith("stall-") ? 503 : 200 });
    }
    if (path === "/inspect") return Response.json({ args, env: process.env });
    return new Response(null, { status: 404 });
  },
});
if (!mode.startsWith("stubborn-")) process.on("SIGTERM", async () => {
  await server.stop(true);
  process.exit(0);
});
