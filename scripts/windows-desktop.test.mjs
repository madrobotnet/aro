import { expect, test } from "bun:test";
import { packageDesktop } from "./package-desktop.mjs";
import { updateCommand } from "./update.mjs";
import { stopWindowsApp } from "./desktop-process";

test.skipIf(process.platform !== "win32")("Windows package and update refuse before filesystem writes", async () => {
  await expect(packageDesktop("unused")).rejects.toMatchObject({ code: "windows-desktop-distribution-unsupported" });
  await expect(updateCommand(["desktop"])).rejects.toMatchObject({ code: "windows-desktop-distribution-unsupported" });
});

test.skipIf(process.platform !== "win32")("Windows stop terminates an actual app child tree", async () => {
  const ready = Promise.withResolvers();
  const parent = Bun.spawn([process.execPath, "--no-env-file", "-e",
    `const child = Bun.spawn([process.execPath,"--no-env-file","-e","setInterval(()=>{},1000)"]);
     process.send(child.pid); setInterval(()=>{},1000);`], {
    ipc: value => { if (typeof value === "number") ready.resolve(value); },
    stdout: "ignore", stderr: "ignore",
  });
  const pid = await Promise.race([ready.promise, parent.exited.then(() => {
    throw new Error("Fixture exited before readiness");
  })]);
  try {
    await stopWindowsApp(parent);
    const probe = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(probe.stdout).text();
    expect(await probe.exited).toBe(0);
    expect(output).not.toMatch(new RegExp(`"${pid}"`));
  } finally {
    if (parent.exitCode === null) await stopWindowsApp(parent);
  }
}, 20_000);
