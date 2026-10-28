import { Suspense } from "react";
import { NotesLoading, NotesWorkspace } from "@/features/notes";
import { NoteRouteTitle } from "@/components/shell/NoteRouteTitle";

export default function NotesPage() {
  return <Suspense fallback={<NotesLoading />}><NoteRouteTitle /><NotesWorkspace /></Suspense>;
}
