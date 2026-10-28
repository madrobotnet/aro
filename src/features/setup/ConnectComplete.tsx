"use client";

import { CircleCheck, CircleX, Clock } from "lucide-react";
import { useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { BrandMark } from "@/components/ui/BrandMark";
import { buttonClassName } from "@/components/ui/Button";
import { brandName } from "@/lib/brand";
import { CONNECT_COPY, type ConnectOutcome } from "./connect-copy";

const ICONS = { pending: Clock, success: CircleCheck, failure: CircleX } as const;
const TONES = { pending: "size-8 text-warn", success: "size-8 text-ok", failure: "size-8 text-danger" } as const;

/** Result window after a provider sign-in; shows no codes or credentials. */
export function ConnectCompleteView({ outcome, setup }: { readonly outcome: ConnectOutcome; readonly setup: boolean }) {
  const { locale } = useLocale();
  const copy = useCopy(CONNECT_COPY);
  const Icon = ICONS[outcome];
  const tab = setup ? copy.setupTab : copy.settingsTab;
  return (
    <section className="surface-card w-full max-w-lg p-5 sm:p-8" aria-labelledby="connect-complete-title">
      <DocumentTitle title={copy.metaTitle} />
      <div className="mb-6 flex items-center gap-2.5">
        <BrandMark className="size-7" />
        <span className="text-md font-semibold tracking-tight">{brandName(locale)}</span>
      </div>
      <Icon aria-hidden className={TONES[outcome]} />
      <h1 id="connect-complete-title" className="mt-3 text-2xl font-semibold tracking-tight">
        {copy[outcome].title}
      </h1>
      <p className="mt-3 text-md leading-relaxed text-mute">{copy[outcome].body(tab)}</p>
      <p className="mt-5 text-sm text-mute">{copy.close}</p>
      <a href={setup ? "/setup" : "/settings"} className={`mt-5 ${buttonClassName({ size: "lg" })}`}>
        {locale === "ko" ? setup ? "최초 설정으로 돌아가기" : "설정으로 돌아가기" : setup ? "Return to setup" : "Return to Settings"}
      </a>
    </section>
  );
}
