/** Windows has no POSIX child signal propagation. Both attempts target the tree. */
export async function stopWindowsApp(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const graceful = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T"], {
    stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(1000),
  });
  try { await graceful.exited; }
  finally {
    const forced = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "ignore", stderr: "ignore", signal: AbortSignal.timeout(10_000),
    });
    const code = await forced.exited;
    if (code !== 0 && child.exitCode === null) throw new Error("Windows app tree termination failed");
    await child.exited;
  }
}
