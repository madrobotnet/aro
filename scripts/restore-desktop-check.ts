#!/usr/bin/env bun
import { desktopArguments, DesktopBackupError, verifyDesktopBackup } from "./backup-desktop-common";

if (import.meta.main) {
  try {
    const args = desktopArguments(["--backup", "--temp-parent"]);
    const backup = args["--backup"];
    const temporaryParent = args["--temp-parent"];
    if (!backup || !temporaryParent) throw new DesktopBackupError("Missing verification paths");
    await verifyDesktopBackup(backup, temporaryParent);
    console.log("Desktop restore verification completed; sandbox removed.");
  } catch (error) {
    console.error(error instanceof DesktopBackupError ? error.message : "Desktop restore verification failed.");
    process.exitCode = 1;
  }
}
