import type { InboxItem } from "@/lib/types";
import { stripUrlStatus, syncTriageDraft, type TriageDraftState } from "./inbox-triage";

export type TriageDraft = {
  readonly edit: TriageDraftState;
  readonly manualTags: string;
  readonly selectedTags: ReadonlySet<string>;
};

/** Mounted InboxView owns these by item ID, independently of selection and view.
 * Refresh source snapshots without replacing fields the user has already edited.
 */
export function triageDraft(item: InboxItem, current?: TriageDraft): TriageDraft {
  const body = stripUrlStatus(item.body);
  const edit = current ? syncTriageDraft(current.edit, item.title, body) : {
    title: item.title, body, sourceTitle: item.title, sourceBody: body, titleDirty: false, bodyDirty: false,
  };
  return current && edit === current.edit ? current : {
    edit, manualTags: current?.manualTags ?? "", selectedTags: current?.selectedTags ?? new Set<string>(),
  };
}
