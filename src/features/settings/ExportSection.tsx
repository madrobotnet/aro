"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { useCopy } from "@/components/i18n";
import { buttonClassName } from "@/components/ui";
import { Section } from "./SettingsSection";
import { SETTINGS_COPY } from "./settings-copy";

/** A plain download link: the browser streams the zip to disk instead of buffering it in a Blob. */
export function ExportSection() {
  const copy = useCopy(SETTINGS_COPY).exportData;
  const [portable, setPortable] = useState(false);
  return (
    <Section id="settings-export" title={copy.title} description={copy.description}>
      <div className="surface-card px-4 py-4 sm:px-5">
        <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
          <input type="checkbox" checked={portable} onChange={(event) => setPortable(event.target.checked)}
            aria-describedby="export-portable-hint" className="size-4" />
          {copy.portable}
        </label>
        <p id="export-portable-hint" className="mb-4 text-sm text-mute">{copy.portableHint}</p>
        <a href={portable ? "/api/export?wikiLinks=portable" : "/api/export"} download className={buttonClassName({ size: "lg" })}>
          <Download aria-hidden className="size-4" />
          {copy.action}
        </a>
        <p className="mt-3 text-sm text-mute">{copy.contents}</p>
      </div>
    </Section>
  );
}
