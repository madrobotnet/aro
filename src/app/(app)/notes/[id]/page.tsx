import { Suspense } from "react";
import { NotesLoading, NotesWorkspace } from "@/features/notes";
import { NoteRouteTitle } from "@/components/shell/NoteRouteTitle";

export default async function NotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<NotesLoading />}><NoteRouteTitle noteId={id} /><NotesWorkspace selectedId={id} /></Suspense>;
}
