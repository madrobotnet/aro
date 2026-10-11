import { choice, noul } from "@typesafe-ai/sdk";
import type { InboxSuggestions } from "@/lib/types";
import type { Locale } from "@/lib/i18n/locale";
import { db } from "@/server/db";
import { databaseBackend, sqliteStore } from "@/server/db/backend";
import { jevCaptureQuestions } from "@/server/i18n/copy";
import { getJev } from "@/server/jev/client";
import type { InboxRow } from "./service";

export function probability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

type Answer = { type?: unknown; noul?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown };

/** Optional provider failures produce proposals, never a failed capture. */
export async function buildSuggestions(item: InboxRow, locale: Locale): Promise<InboxSuggestions> {
  try {
    const jev = await getJev();
    if (!jev) return { status: "unavailable", tags: [], kind: null, duplicateOf: null };
    const notes = { rows: databaseBackend() === "sqlite"
      ? (await sqliteStore()).all<{ id: string; title: string }>(
        "SELECT id,title FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 20")
      : (await (await db()).query<{ id: string; title: string }>(
        "SELECT id,title FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20")).rows };
    const copy = jevCaptureQuestions(locale);
    const duplicateChoices: Record<string, string | null> = { none: copy.noDuplicate };
    for (const note of notes.rows) duplicateChoices[note.id] = note.title;
    const response = await jev.systemOne({
      state: { title: item.title, body: item.body.slice(0, 4000), existingNotes: notes.rows },
      questions: {
        kind: choice(copy.kindQuestion, copy.kindLabels),
        tag_idea: noul(copy.tagIdea), tag_reference: noul(copy.tagReference), tag_task: noul(copy.tagTask),
        ...(notes.rows.length ? { duplicate: choice(copy.duplicate, duplicateChoices) } : {}),
      },
    });
    const answers = response.answers as Record<string, Answer>;
    const tags = ["idea", "reference", "task"].flatMap((tag) => {
      const score = probability(answers[`tag_${tag}`]?.noul);
      return score !== null && score >= 0.5 ? [{ tag, probability: score }] : [];
    }).sort((a, b) => b.probability - a.probability);
    const kindAnswer = answers.kind;
    const kindConfidence = probability(kindAnswer?.confidence);
    const kind = typeof kindAnswer?.choice === "string" && kindConfidence !== null
      ? { choice: kindAnswer.choice, confidence: kindConfidence } : null;
    const duplicate = answers.duplicate;
    const probabilities = duplicate?.probabilities && typeof duplicate.probabilities === "object"
      ? duplicate.probabilities as Record<string, unknown> : null;
    const selected = typeof duplicate?.choice === "string" ? duplicate.choice : null;
    const matched = selected && selected !== "none" ? notes.rows.find((note) => note.id === selected) : null;
    const duplicateProbability = selected && probabilities ? probability(probabilities[selected]) : null;
    const duplicateOf = matched && duplicateProbability !== null
      ? { noteId: matched.id, title: matched.title, probability: duplicateProbability } : null;
    return { status: "ready", tags, kind, duplicateOf };
  } catch {
    // Optional-provider boundary: the existing contract exposes failure as a proposal status.
    return { status: "failed", tags: [], kind: null, duplicateOf: null };
  }
}
