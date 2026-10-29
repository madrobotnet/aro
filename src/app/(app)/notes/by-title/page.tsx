import { redirect } from "next/navigation";
import { z } from "zod";
import { ReferenceDestination } from "@/features/notes/ReferenceDestination";
import { getSession } from "@/server/auth/session";
import { findNoteReference } from "@/server/notes/reference";

const Title = z.string().trim().min(1).max(300);

export default async function ReferencePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly title?: string | string[] }>;
}) {
  // Layouts can render concurrently with pages. Authenticate before any lookup.
  if (!await getSession()) redirect("/login");
  const parsed = Title.safeParse((await searchParams).title);
  if (!parsed.success) return <ReferenceDestination state={{ kind: "invalid" }} />;
  let note;
  try {
    note = await findNoteReference(parsed.data);
  } catch {
    // A failed read is never evidence that the note is missing.
    return <ReferenceDestination state={{ kind: "failed" }} />;
  }
  if (note) redirect(`/notes/${note.id}`);
  return <ReferenceDestination state={{ kind: "missing", title: parsed.data }} />;
}
