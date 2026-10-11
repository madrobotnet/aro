import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupScreen } from "@/features/setup/SetupScreen";
import { SETUP_COPY } from "@/features/setup/setup-copy";
import { getRequestLocale } from "@/lib/i18n/server";
import { setupState } from "@/server/setup/service";
import { databaseConfigured as hasDatabase } from "@/server/db/backend";

export async function generateMetadata(): Promise<Metadata> {
  const copy = SETUP_COPY[await getRequestLocale()];
  return { title: copy.metaTitle, robots: { index: false, follow: false } };
}

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const databaseConfigured = hasDatabase();
  const state = databaseConfigured ? await setupState() : "disabled";
  if (state === "complete") redirect("/login");

  return (
    <main className="min-h-dvh bg-canvas bg-grain px-4 py-8 sm:px-6 lg:py-16">
      <SetupScreen ready={state === "ready"} databaseConfigured={databaseConfigured} />
    </main>
  );
}
