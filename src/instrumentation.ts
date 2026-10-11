export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { databaseConfigured } = await import("@/server/db/backend");
    if (!databaseConfigured()) return;
    const { startNoteMaintenance } = await import("@/server/notes/trash");
    // Replay durable work and run trash and revision retention now and on a schedule, without
    // coupling server readiness to storage health.
    startNoteMaintenance();
    const { startSemanticIndexing } = await import("@/server/search/indexer");
    startSemanticIndexing();
  }
}
