import { useState } from "react";
import { Input } from "@/components/ui";
import { mergeCommaItems } from "./comma-items";

export function AliasField({ label, defaultValue, placeholder, onCommit }: {
  readonly label: string;
  readonly defaultValue: string;
  readonly placeholder: string;
  readonly onCommit: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState({ base: defaultValue, value: defaultValue });
  if (draft.base !== defaultValue && draft.value === draft.base) {
    setDraft({ base: defaultValue, value: defaultValue });
  }
  return (
    <Input
      label={label}
      value={draft.value}
      placeholder={placeholder}
      onChange={(event) => setDraft({ ...draft, value: event.target.value })}
      onBlur={(event) => {
        const values = mergeCommaItems(event.target.value, draft.base, defaultValue);
        setDraft({ base: values.join(", "), value: values.join(", ") });
        if (values.join(", ") !== defaultValue) onCommit(values);
      }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    />
  );
}
