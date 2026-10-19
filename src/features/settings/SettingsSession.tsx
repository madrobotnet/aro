"use client";

import { LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { useCopy, useLocale } from "@/components/i18n";
import { useShell } from "@/components/shell/ShellProvider";
import { Badge, Button, Dialog, Skeleton } from "@/components/ui";
import { hasUnsavedNoteDrafts } from "@/features/notes/draft-store";
import { api } from "@/lib/api-client";
import { localizedApiError } from "@/lib/i18n/api-error";
import { Section } from "./SettingsSection";
import { SETTINGS_COPY } from "./settings-copy";
import { daysUntil, formatExpiry, type RevokeAllResult, type SessionInfo } from "./settings-model";

type Stamped<T> = { value: T; fetchedAt: number };
const fetchSession = async (path: string): Promise<Stamped<SessionInfo>> => ({ value: await api<SessionInfo>(path), fetchedAt: Date.now() });

export function SessionSection() {
  const { logout } = useShell();
  const { locale } = useLocale();
  const copy = useCopy(SETTINGS_COPY).session;
  const { data, error, isLoading, mutate } = useSWR<Stamped<SessionInfo>>("/api/auth/me", fetchSession, { revalidateOnFocus: true });
  const [loggingOut, setLoggingOut] = useState(false);

  const expiresAt = data?.value.expiresAt ?? null;
  const days = data ? daysUntil(expiresAt, data.fetchedAt) : null;

  return (
    <Section id="settings-session" title={copy.title} description={copy.description}>
      <div className="surface-card px-4 py-4 sm:px-5">
        {isLoading && !data ? (
          <div aria-label={copy.loading} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-64 max-w-full" />
          </div>
        ) : error && !data ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-md font-medium text-danger">{copy.loadFailed}</p>
            <p className="text-sm text-mute">{localizedApiError(error, locale, copy.loadHint)}</p>
            <Button size="lg" leading={<RefreshCw aria-hidden className="size-4" />} onClick={() => void mutate()}>
              {copy.reload}
            </Button>
          </div>
        ) : (
          <dl>
            <dt className="text-sm text-mute">{copy.expiryLabel}</dt>
            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {expiresAt ? (
                <>
                  <time dateTime={expiresAt} className="text-md font-medium">
                    {formatExpiry(expiresAt, locale)}
                  </time>
                  {days !== null ? <Badge tone={days <= 3 ? "warn" : "neutral"}>{days === 0 ? copy.expiresToday : copy.daysLeft(days)}</Badge> : null}
                </>
              ) : (
                <span className="text-md">{copy.noExpiry}</span>
              )}
            </dd>
          </dl>
        )}
        <p className="mt-3 text-sm text-mute">{copy.renewNote}</p>
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row">
          <Button
            size="lg"
            leading={<LogOut aria-hidden className="size-4" />}
            loading={loggingOut}
            onClick={() => {
              setLoggingOut(true);
              void logout().finally(() => setLoggingOut(false));
            }}
          >
            {copy.logout}
          </Button>
        </div>
      </div>
    </Section>
  );
}

export function SessionDangerSection() {
  const router = useRouter();
  const { locale } = useLocale();
  const copy = useCopy(SETTINGS_COPY).session;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  // Retain the cause, so a language switch also updates the visible failure.
  const [revokeError, setRevokeError] = useState<{ readonly cause: unknown } | null>(null);
  const revokeAll = async () => {
    if (hasUnsavedNoteDrafts() && !window.confirm(copy.unsavedDrafts)) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await api<RevokeAllResult>("/api/auth/sessions/revoke-all", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (cause) {
      setRevokeError({ cause });
      setRevoking(false);
    }
  };
  const setConfirm = (open: boolean) => {
    setConfirmOpen(open);
    if (!open) setRevokeError(null);
  };
  return (
    <Section id="settings-session-danger" title={copy.logoutAll} description={copy.confirmDescription}>
      <Button variant="danger" size="lg" leading={<ShieldAlert aria-hidden className="size-4" />} onClick={() => setConfirm(true)}>
        {copy.logoutAll}
      </Button>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirm}
        size="sm"
        bodyClassName="empty:hidden"
        title={copy.confirmTitle}
        description={copy.confirmDescription}
        footer={
          <>
            <Button size="lg" disabled={revoking} onClick={() => setConfirm(false)}>
              {copy.cancel}
            </Button>
            <Button variant="danger" size="lg" loading={revoking} onClick={() => void revokeAll()}>
              {copy.confirm}
            </Button>
          </>
        }
      >
        {revokeError ? (
          <p role="alert" className="rounded-ctl bg-danger-soft px-3 py-2 text-sm text-danger">
            {localizedApiError(revokeError.cause, locale, copy.revokeFailed)}
          </p>
        ) : null}
      </Dialog>
    </Section>
  );
}
