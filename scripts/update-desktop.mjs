import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { installDesktop } from "./install-desktop.mjs";
import { MacOSDesktopDistributionError, WindowsDesktopDistributionError } from "./package-desktop.mjs";
import { backupDesktop, verifyDesktopBackup } from "./backup-desktop-common.ts";
import { absent, artifact, owned, separate, seal, plan } from "./update-common.mjs";

export async function updateDesktop(input) {
  if (process.platform === "win32") throw new WindowsDesktopDistributionError();
  if (process.platform === "darwin") throw new MacOSDesktopDistributionError();
  const current = input["current-directory"], data = input["data-dir"], target = input.directory;
  const backup = input.backup, temporary = input["temp-parent"];
  separate([current, data, target, backup, temporary]);
  await owned(current, true);
  await owned(data, true);
  await owned(temporary, true);
  await absent(target);
  await absent(backup);
  await owned(join(current, "desktop-release.json"), false, false);
  const previous = JSON.parse(await readFile(join(current, "desktop-release.json"), "utf8"));
  assert(previous.schemaVersion === 1 && previous.entrypoint === "scripts/desktop.js" &&
    previous.platform === process.platform && previous.arch === process.arch, "Unsupported current desktop package");
  assert(/^\d+\.\d+\.\d+$/.test(previous.version) &&
    Bun.semver.satisfies(input.version, `>${previous.version}`), "Only a newer stable target is supported; no DB downgrade");
  const bytes = await artifact(input, 512 * 1024 * 1024);
  const checked = await installDesktop(bytes, input.sha256, target, true);
  assert.equal(checked.version, input.version, "Target desktop version mismatch");
  const members = await new Bun.Archive(bytes).files();
  for (const name of members.keys()) assert(!/^aro\/(?:update-activation\.json|\.data|aro\.sqlite|attachments|runtime\.lock\.sqlite)(?:\/|$)/.test(name),
    "Desktop package contains reserved operator/data paths");
  // No app artifact is written until the stopped runtime has a restorable snapshot.
  await backupDesktop(data, backup, async () => {
    await verifyDesktopBackup(backup, temporary);
    await installDesktop(bytes, input.sha256, target);
    await plan(target, {
      mode: "desktop", version: input.version, archiveSha256: input.sha256,
      previousDirectory: current, dataDirectory: data, backup,
      activation: [process.execPath, "--no-env-file", join(target, "scripts/desktop.js"),
        "start", "--data-dir", data],
      recovery: "Restore the verified pre-upgrade backup into a NEW data directory before selecting the previous app.",
    });
    await seal(target);
  });
  return { state: "verified-staged-not-started", mode: "desktop", directory: target, backup };
}
