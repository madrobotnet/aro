# UI primitives and shell

Everything here is token-driven: colors, radii, shadows and spacing come from the
`@theme` block in `src/app/globals.css` (`bg-canvas`, `bg-desk`, `bg-card`, `text-ink`,
`text-mute`, `border-line`, `bg-accent`, `text-ok|warn|danger`, `rounded-ctl|card|pill`,
`shadow-card|pop`, `rail-*`). Do not hardcode hex values or pixel sizes in feature code;
add a token instead. Copy lives in per-area `copy.ts` catalogs (Korean source, English
translation) read with `useCopy`; the product name comes from `brandName(locale)` in `@/lib/brand`.

Shared tokens beyond the palette:

- `--focus`: focus color, solid accent. `:focus-visible` draws a 2px `--focus` outline and
  `focus-ring` a 2px `--focus` box-shadow; accent-filled controls use `focus-ring-offset`
  (outline with a 2px gap). The desktop rail sets `[--focus:var(--rail-ink)]`
  on its `<nav>`; a custom inset rule can use `var(--focus)` too.
- `text-rail-accent` (`--rail-accent`): the active rail icon; the rail is dark in both themes.
- `text-read` (`--text-read-size` 16px / `--text-read-leading` 28px): long-form reading text;
  `prose-ko` uses the same pair.
- `bg-graph-1` … `bg-graph-6` (`--graph-1` … `--graph-6`): categorical colors for graph tags,
  separate from the `ok`/`warn`/`danger` states.

Never mark selection or the active item with an accent edge (stripe, side border, accent
outline); use a tonal wash plus a label or glyph. Page headers follow the recipe in
`DESIGN.md` §4 (no eyebrow).

## `@/components/ui`

| Export | Signature | Notes |
| --- | --- | --- |
| `cn` | `(...inputs: ClassValue[]) => string` | clsx class-name joiner; does not merge conflicting Tailwind utilities. |
| `BrandMark` | `({ className? })` | Aro "Interlock" mark in `currentColor`: 20px accent by default (`.brand-mark`), and any `size-*` / `text-*` class wins. Decorative (`aria-hidden`), so name the enclosing link or show the brand name beside it. |
| `Button` | `forwardRef<HTMLButtonElement, ButtonProps>` — `variant?: "primary" \| "secondary" \| "ghost" \| "danger" \| "rail"`, `size?: "sm" \| "md" \| "lg"`, `iconOnly?`, `loading?`, `leading?`, `trailing?` + native button props | `loading` sets `aria-busy` and disables; `iconOnly` needs `aria-label`. |
| `buttonClassName` | `(opts?: { variant?; size?; iconOnly? }) => string` | For `<Link>`/`<a>` styled as buttons. |
| `Input` / `Textarea` | `forwardRef` — `label?`, `hint?`, `error?`, `wrapperClassName?`, (`Input` only) `leading?`, `trailing?` + native props | `error` sets `aria-invalid` and `aria-describedby`. |
| `inputClassName` | `string` | Bare control class for custom fields. |
| `Dialog` | `({ open, onOpenChange, title?, description?, children?, footer?, initialFocusRef?, hideTitle?, size?: "sm" \| "md" \| "lg", className?, bodyClassName? })` | Native `<dialog showModal>`: focus trap, Escape, backdrop click, focus restore to the opener, scroll lock. |
| `Sheet` | same as `Dialog` minus `size` | Bottom sheet on mobile, centered card from `sm:`. |
| `useModalDialog` | `(open, onOpenChange, initialFocusRef?) => { ref, onClose, onBackdropClick }` | Build custom modals (used by the command palette). |
| `EmptyState` | `({ icon?, title, description?, action?, variant?: "panel" \| "plain", className? })` | One-sentence description that says what to do next. |
| `Badge` / `TagBadge` | `({ tone?: "neutral" \| "accent" \| "ok" \| "warn" \| "danger" \| "rail", count?, ... })` / `({ tag })` | `count` renders a numeric pill (99+ cap). |
| `ToastProvider` / `useToast` / `toastText` | `useToast(): { toast(message: LocalizedText, { tone?, action?: { label: LocalizedText, onClick }, durationMs? }): number; dismiss(id): void }` | Live region; `durationMs: 0` keeps the toast until closed. Messages and action labels carry `{ ko, en }` and render in the current locale. Use `textInEveryLocale` from `@/lib/i18n/copy` to retain both catalog or API-error translations; passing a preselected string is a type error. |
| `Kbd` / `Shortcut` | `Kbd({ variant?: "default" \| "onAccent" \| "onRail", ...props })` / `Shortcut({ keys: readonly string[], variant? })` | Keycaps for hints. Pick the surface with `variant`; a color `className` cannot override the base (`cn` does not merge classes). |
| `Skeleton` / `SkeletonLines` | `Skeleton(divProps)` / `SkeletonLines({ lines? })` | Loading placeholders. |
| `UI_COPY` | copy catalog | Accessible names of the primitives' close and dismiss buttons. |

## `@/components/shell`

| Export | Signature | Notes |
| --- | --- | --- |
| `AppShell` | `({ children })` | Rail (desktop), top bar + bottom nav (mobile), `main#main`, palette, capture launcher, toasts. Rendered by `src/app/(app)/layout.tsx` after the server session check. |
| `ShellProvider` / `useShell` | `useShell(): { openCapture(): void; closeCapture(); captureOpen; openPalette(mode?: "all" \| "notes"); closePalette(); paletteOpen; inboxCount: number \| null; refreshInbox(); railExpanded; setRailExpanded(bool); logout(): Promise<void>; theme; resolvedTheme; setTheme(theme); cycleTheme() }` | `openCapture` renders the inbox lane's `<CaptureDialog open onOpenChange />`. Global keys: `Ctrl/⌘+K` palette, `Ctrl/⌘+P` note switcher, `c` capture, `/` search, `g` + `h i n t s g c` go-to; single keys are ignored inside inputs, textareas, contenteditable and the CodeMirror editor. |
| `ThemeProvider` / `useTheme` | `useTheme(): { theme: "system" \| "light" \| "dark"; resolvedTheme: "light" \| "dark"; setTheme; cycleTheme }` | `useSyncExternalStore` over localStorage + `prefers-color-scheme`; the inline `THEME_INIT_SCRIPT` in the root layout applies `.dark` before hydration, so no hydration mismatch. |
| `CommandPalette` | `({ open, mode, onOpenChange, onModeChange, onCapture? })` | cmdk over `/api/notes/titles`; actions (capture, new note, today), navigation, theme, and "New note: <query>" when the query matches no title. Search matches labels in both languages. |
| `NAV_ITEMS`, `navItem`, `isNavActive`, `activeNavId`, `MOBILE_PRIMARY`, `MOBILE_MORE`, `isMoreActive`, `goToHref` | see `nav.ts` | Single source of routes, icons and chord keys; labels are `SHELL_COPY[locale].nav[id]`. `NavId` derives from the item list. The mobile bar is `MOBILE_PRIMARY` = home, inbox, notes (capture sits between inbox and notes, then More); everything else is in the More sheet. |
| `resolveShortcut`, `isEditableTarget`, `modKey`, `IDLE_CHORD`, `CHORD_TIMEOUT_MS` | see `shortcuts.ts` | Pure keymap; unit-tested. |
| `THEME_INIT_SCRIPT`, `RAIL_INIT_SCRIPT`, `*_STORAGE_KEY` | strings | Inlined by `src/app/layout.tsx`. With no stored rail choice, `RAIL_INIT_SCRIPT` and `readRailExpanded` expand the rail at `(min-width: 1280px)`; a stored `open`/`closed` wins. |
| `SHELL_COPY`, `BOUNDARY_COPY`, `everyLocale`, `keywordsInEveryLocale` | see `copy.ts` | Shell and error-page copy. `everyLocale(pick)` returns a `LocalizedText` for toasts that stay open; `keywordsInEveryLocale(...picks)` feeds palette search in both languages. |
| `StatusScreen` | `({ kind: "notFound" } \| { kind: "error", onRetry, digest? })` | Brand card for the root not-found, error and global-error boundaries; shows the error digest, never the raw message, and sets the tab title. |
| `Mark` | alias of `BrandMark` | Deprecated; import `BrandMark` from `@/components/ui`. |

## `@/lib/i18n/format-date`

The only way to display a date or time. Pure; `timeZone` defaults to the runtime (browser) zone, and no output shows seconds.

| Export | Signature | Output |
| --- | --- | --- |
| `formatDate` | `(value: DateInput, locale, { timeZone? }?) => string` | ko `2026-09-29`, en `Sep 29, 2026`; invalid input gives `""`. |
| `formatDateTime` | `(value: DateInput, locale, { timeZone? }?) => string` | ko `2026-09-29 오후 7:18`, en `Sep 29, 2026, 7:18 PM`; invalid input gives `""`. |
| `formatDayHeading` | `(key: "YYYY-MM-DD", locale, { weekday? }?) => string` | `9월 29일 화요일` / `Tuesday, September 29`; `weekday: false` gives `9월 29일` / `September 29`. Reads the key as a calendar date, with no zone shift. |
| `localDateKey` | `(value?: DateInput, timeZone?) => string` | `YYYY-MM-DD` of `value` (default now) in the zone. |
| `calendarDaysAgo` | `(value: DateInput, now?: number, timeZone?) => number` | Calendar days from `value` to `now`: 0 is the same date, 1 is the day before. |

`DateInput` is `string | number | Date`.

## `@/features/auth`

| Export | Signature | Notes |
| --- | --- | --- |
| `LoginForm` | `({ next: string })` | Posts `/api/auth/login`; shows 401 copy, lockout countdown from `retryAfterSeconds`, then `window.location.assign(next)`. |
| `sanitizeNextUrl` | `(raw) => string` | Same-origin relative path or `/`. |
| `LOGIN_COPY`, `formatRemaining` | | Korean copy and minutes/seconds formatting. |
