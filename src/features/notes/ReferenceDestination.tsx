"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { Button, buttonClassName } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import type { NoteRef } from "@/lib/types";

const COPY = {
  en: {
    heading: "Note reference",
    missing: "This note does not exist yet. Create it when you are ready to write.",
    invalid: "This reference needs a title between 1 and 300 characters.",
    failed: "The note could not be looked up. Try again before creating anything.",
    create: "Create note",
    createFailed: "Could not create the note. Try again.",
    retry: "Try lookup again",
    notes: "Back to notes",
  },
  ko: {
    heading: "노트 참조",
    missing: "아직 없는 노트예요. 작성할 준비가 되면 만들어 주세요.",
    invalid: "참조 제목은 1자 이상 300자 이하여야 해요.",
    failed: "노트를 찾지 못했어요. 새로 만들기 전에 다시 확인해 주세요.",
    create: "노트 만들기",
    createFailed: "노트를 만들지 못했어요. 다시 시도해 주세요.",
    retry: "다시 찾기",
    notes: "노트 목록으로",
  },
} as const;

export type ReferenceDestinationState =
  | { readonly kind: "missing"; readonly title: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "failed" };

export function ReferenceDestination({ state }: { readonly state: ReferenceDestinationState }) {
  const copy = useCopy(COPY);
  const { locale } = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ readonly error: unknown } | null>(null);
  const create = async () => {
    if (state.kind !== "missing" || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const { note } = await api<{ note: NoteRef }>("/api/notes/by-title", { method: "POST", json: { title: state.title } });
      router.replace(`/notes/${note.id}`);
    } catch (error) {
      setFailure({ error });
      setBusy(false);
    }
  };
  return (
    <section className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <DocumentTitle title={copy.heading} />
      <h1 className="text-2xl font-semibold tracking-tight">{copy.heading}</h1>
      {state.kind === "missing" ? <p className="mt-4 break-words text-lg font-medium">{state.title}</p> : null}
      <p className="mt-2 text-sm text-mute">{copy[state.kind]}</p>
      {failure ? <p role="alert" className="mt-4 text-sm text-danger">{localizedApiError(failure.error, locale, copy.createFailed)}</p> : null}
      <div className="mt-6 flex flex-wrap gap-2">
        {state.kind === "missing" ? <Button variant="primary" loading={busy} disabled={busy} onClick={() => void create()}>{copy.create}</Button> : null}
        {state.kind === "failed" ? <Button onClick={() => router.refresh()}>{copy.retry}</Button> : null}
        <Link href="/notes" className={buttonClassName()}>{copy.notes}</Link>
      </div>
    </section>
  );
}
