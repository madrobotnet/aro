"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useCopy } from "@/components/i18n";
import { Button, cn, Sheet } from "@/components/ui";
import { EDITOR_HEADER_COPY } from "./editor-header-copy";
import { menuKeyIndex } from "./menu-key";

export type NoteMenuAction = { readonly label: string; readonly icon: ReactNode; readonly danger?: boolean; readonly run: () => void };

export function NoteMoreMenu({ actions, disabled }: { readonly actions: readonly NoteMenuAction[]; readonly disabled: boolean }) {
  const copy = useCopy(EDITOR_HEADER_COPY);
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstItem = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const sync = () => { setMobile(query.matches); setOpen(false); };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!open || mobile) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false); trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, mobile]);
  const contents = <div ref={menu} id={id} role="menu" aria-label={copy.more} onKeyDown={(event) => {
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return; }
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const next = menuKeyIndex(event.key, items.findIndex((item) => item === document.activeElement), items.length);
    if (next !== null) { event.preventDefault(); items[next]?.focus(); }
  }}>
    {actions.map((action, index) => <button ref={index === 0 ? firstItem : undefined} key={action.label} type="button" role="menuitem" className={cn("flex min-h-touch w-full items-center gap-3 rounded-ctl px-3 py-2 text-left text-sm hover:bg-desk", action.danger ? "text-danger hover:bg-danger-soft" : "text-ink")} onClick={() => { close(); action.run(); }}>{action.icon}{action.label}</button>)}
  </div>;
  return <div ref={container} className="relative shrink-0">
    <Button ref={trigger} iconOnly variant="ghost" className="min-h-touch min-w-touch" aria-label={copy.more} title={copy.more} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}><MoreHorizontal aria-hidden className="size-4" /></Button>
    {mobile ? <Sheet open={open} onOpenChange={setOpen} title={copy.more} initialFocusRef={firstItem}>{contents}</Sheet> : open ? <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-card border border-line bg-card p-1 shadow-pop">{contents}</div> : null}
  </div>;
}
