"use client";

import { useState } from "react";
import { LanguageSwitch, useCopy, useLocale } from "@/components/i18n";
import { DocumentTitle } from "@/components/i18n/DocumentTitle";
import { BrandMark, Button } from "@/components/ui";
import type { AgentScope } from "@/lib/agent-access";
import { brandName } from "@/lib/brand";
import { OAUTH_COPY } from "./oauth-copy";

type ConsentProps = {
  readonly clientName: string; readonly redirectHost: string; readonly request: string;
  readonly scopes: readonly AgentScope[];
};

export function OAuthConsent(props: ConsentProps) {
  const copy = useCopy(OAUTH_COPY);
  const { locale } = useLocale();
  const [scopes, setScopes] = useState<readonly AgentScope[]>(props.scopes.filter(scope => scope !== "propose-write"));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const labels = {
    read: [copy.read, copy.readHelp], capture: [copy.capture, copy.captureHelp], "propose-write": [copy.propose, copy.proposeHelp],
  } as const;

  async function submit(decision: "approve" | "deny") {
    setBusy(true); setFailed(false);
    try {
      const response = await fetch("/oauth/authorize/decision", {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: props.request, decision, scopes }),
      });
      if (!response.ok) { setFailed(true); setBusy(false); return; }
      const result: unknown = await response.json();
      if (typeof result !== "object" || result === null || !("redirectTo" in result) || typeof result.redirectTo !== "string") {
        setFailed(true); setBusy(false); return;
      }
      window.location.assign(result.redirectTo);
    } catch { setFailed(true); setBusy(false); }
  }

  return (
    <section className="w-full max-w-lg surface-card p-6 sm:p-8" aria-labelledby="consent-heading">
      <DocumentTitle title={copy.title} />
      <div className="mb-6 flex items-center gap-2.5">
        <BrandMark className="size-7" /><span className="text-md font-semibold">{brandName(locale)}</span>
      </div>
      <h1 id="consent-heading" className="text-xl font-semibold">{copy.title}</h1>
      <p className="mt-2 text-sm text-mute">{copy.lead}</p>
      <dl className="mt-6 space-y-3 border-y border-line py-4 text-sm">
        <div><dt className="text-mute">{copy.client}</dt><dd className="mt-1 break-words font-medium">{props.clientName}</dd></div>
        <div><dt className="text-mute">{copy.redirect}</dt><dd className="mt-1 break-all font-medium">{props.redirectHost}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-mute">{copy.unverified}</p>
      <form className="mt-6" action="/oauth/authorize/decision" method="post" onSubmit={event => {
        event.preventDefault();
        const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        void submit(submitter instanceof HTMLButtonElement && submitter.value === "deny" ? "deny" : "approve");
      }}>
        <input type="hidden" name="request" value={props.request} />
        <fieldset disabled={busy} className="space-y-3">
          <legend className="mb-3 text-sm font-medium">{copy.permissions}</legend>
          {props.scopes.map(scope => <label key={scope} className="flex min-h-touch cursor-pointer items-start gap-3 py-2">
            <input type="checkbox" name="scopes" value={scope} checked={scopes.includes(scope)} className="mt-1 size-4 accent-accent"
              onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(item => item !== scope))} />
            <span><span className="block text-base font-medium">{labels[scope][0]}</span>
              <span className="mt-1 block text-sm text-mute">{labels[scope][1]}</span></span>
          </label>)}
        </fieldset>
        {scopes.includes("propose-write") && <p className="mt-4 rounded-ctl bg-desk p-3 text-sm text-mute">{copy.notes}</p>}
        {failed && <div className="mt-4 text-sm" role="alert">
          <p className="text-danger">{copy.failed}</p>
          <a className="mt-2 inline-block text-accent underline" href={`/login?next=${encodeURIComponent(`/oauth/authorize?${props.request}`)}`}>{copy.login}</a>
        </div>}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button type="submit" name="decision" value="approve" variant="primary" loading={busy} disabled={!scopes.length}>
            {busy ? copy.pending : copy.approve}
          </Button>
          <Button type="submit" name="decision" value="deny" disabled={busy}>{copy.deny}</Button>
        </div>
      </form>
      <p className="mt-4 text-sm text-mute">{copy.revoke}</p>
      <div className="mt-6 border-t border-line pt-4"><LanguageSwitch /></div>
    </section>
  );
}
