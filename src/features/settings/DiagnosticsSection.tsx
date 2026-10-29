"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n";
import { Button } from "@/components/ui";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { Section } from "./SettingsSection";

export function DiagnosticsSection() {
  const { locale } = useLocale();
  const ko = locale === "ko";
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly cause: unknown } | null>(null);
  async function prepare() {
    setBusy(true); setError(null);
    try { setReport(JSON.stringify(await api<unknown>("/api/settings/diagnostics"), null, 2)); }
    catch (cause) { setError({ cause }); }
    finally { setBusy(false); }
  }
  return <Section id="settings-diagnostics" title={ko ? "로컬 진단" : "Local diagnostics"}
    description={ko ? "문제를 제보할 때 필요한 최소 정보만 직접 확인하고 저장하세요." : "Review and save minimal information when reporting a problem."}>
    <div className="space-y-3">
      <p className="text-sm text-mute">{ko
        ? "앱 버전·실행 환경·전체 항목 수만 포함해요. 노트 내용, 토큰, 계정, 주소, 파일 경로는 제외하며 외부로 자동 전송하지 않아요."
        : "Includes app version, runtime and aggregate counts. Excludes note content, tokens, accounts, addresses and file paths. Nothing is sent externally."}</p>
      <Button type="button" disabled={busy} onClick={() => void prepare()}>{ko ? "진단 내용 확인" : "Review diagnostics"}</Button>
      {error && <p role="alert" className="text-sm text-danger">{localizedApiError(error.cause, locale, ko ? "진단을 만들지 못했어요. 다시 시도하세요." : "Could not prepare diagnostics. Try again.")}</p>}
      {report && <>
        <pre className="max-h-72 overflow-auto rounded border border-line p-3 text-xs">{report}</pre>
        <Button type="button" onClick={() => {
          const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url; link.download = "aro-diagnostics.json"; link.click();
          URL.revokeObjectURL(url);
        }}>{ko ? "확인한 JSON 저장" : "Save reviewed JSON"}</Button>
      </>}
    </div>
  </Section>;
}
