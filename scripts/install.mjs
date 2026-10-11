#!/usr/bin/env bun
import { desktopInstallCommand } from "./install-desktop.mjs";
import { serverInstallCommand } from "./install-server.mjs";

const [mode, ...args] = process.argv.slice(2);
if (mode === "desktop") {
  try { console.log(JSON.stringify(await desktopInstallCommand(args))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else if (mode === "server") {
  try { await serverInstallCommand(args); }
  catch { console.error("Server installation was not confirmed. Preserve existing files and inspect the installation state before retrying."); process.exitCode = 1; }
} else {
  console.error("Usage: bun scripts/install.mjs desktop|server [mode-specific options]");
  process.exitCode = 1;
}
