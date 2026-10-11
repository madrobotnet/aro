#!/usr/bin/env bun
import { backupDesktop, desktopArguments, DesktopBackupError } from "./backup-desktop-common";

if (import.meta.main) {
  try {
    const args = desktopArguments(["--data-dir", "--output"]);
    const directory = args["--data-dir"];
    const output = args["--output"];
    if (!directory || !output) throw new DesktopBackupError("Missing backup paths");
    await backupDesktop(directory, output);
    console.log("Desktop backup completed.");
  } catch (error) {
    console.error(error instanceof DesktopBackupError ? error.message : "Desktop backup failed; no completed backup was created.");
    process.exitCode = 1;
  }
}
