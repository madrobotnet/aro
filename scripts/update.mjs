#!/usr/bin/env bun
import { updateOptions } from "./update-common.mjs";
import { updateDesktop } from "./update-desktop.mjs";
import { updateServer } from "./update-server.mjs";
import { WindowsDesktopDistributionError } from "./package-desktop.mjs";

export async function updateCommand(argv) {
  const [mode, ...args] = argv;
  if (process.platform === "win32" && mode === "desktop") {
    throw new WindowsDesktopDistributionError();
  }
  const common = ["version", "sha256", "archive", "current-directory", "directory", "backup"];
  switch (mode) {
    case "desktop": return updateDesktop(updateOptions(args, [...common, "data-dir", "temp-parent"]));
    case "server": return updateServer(updateOptions(args, [...common, "project", "authenticated"]));
    default: throw new Error("Usage: bun --no-env-file scripts/update.mjs desktop|server --version VERSION --sha256 HASH --archive FILE --current-directory CURRENT --directory NEW --backup NEW_BACKUP; desktop also requires --data-dir DIR --temp-parent DIR; server requires --project ORIGINAL --authenticated yes");
  }
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await updateCommand(process.argv.slice(2)))); }
  catch (error) {
    console.error(process.platform === "win32" && process.argv[2] === "desktop" ? error.message
      : "UPDATE_FAILED: no activation confirmed. Preserve staged files, backup and data; the server may remain stopped. See docs/UPDATE.md.");
    process.exitCode = 1;
  }
}
