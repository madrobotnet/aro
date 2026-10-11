import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { LOGIN_COPY } from "@/features/auth/login-copy";
import { sanitizeNextUrl } from "@/features/auth/next-url";
import { getRequestLocale } from "@/lib/i18n/server";
import { getSession } from "@/server/auth/session";
import { setupState } from "@/server/setup/service";
import { databaseConfigured } from "@/server/db/backend";

export async function generateMetadata(): Promise<Metadata> {
  const copy = LOGIN_COPY[await getRequestLocale()];
  return { title: copy.metaTitle, robots: { index: false, follow: false } };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = sanitizeNextUrl(params.next);
  if (!databaseConfigured()) redirect("/setup");
  if (await getSession()) redirect(next);
  if (await setupState() !== "complete") redirect("/setup");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas bg-grain px-4 py-10">
      <LoginScreen next={next} />
    </main>
  );
}
