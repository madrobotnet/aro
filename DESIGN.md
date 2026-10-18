# Aro interface contract

## 1. Purpose

A private Korean/English knowledge workbench: capture first, organize later, connect
ideas while writing, and retrieve the source behind an answer. Preserve the
existing desk direction rather than introduce a new marketing aesthetic.
Product research and adoption decisions live in `docs/research/ADOPTION.md`.

## 2. Color and material

`src/app/globals.css` is the executable token source. Light surfaces use canvas
`#efe8dc`, desk `#f7f2ea`, card `#fffcf7`, ink `#1c1917`, line `#e4dccf` and accent
`#a24518`. The charcoal navigation rail is `#2a2622`. Dark mode replaces these
through `.dark`, not component-local colors.
Small text and placeholder colors meet 4.5:1 against their semantic surfaces.
The light secondary, success and warning shades are `#68615b`, `#356d42` and
`#885a0f`. Static brand artwork keeps the canonical terracotta `#c45c26`.

Use `bg-canvas`, `bg-desk`, `bg-card`, `text-ink`, `text-mute`, `border-line` and
the semantic `ok`, `warn`, `danger` tokens. Card elevation is subtle; floating
dialogs use `shadow-pop`. Selection uses a tonal wash and an understandable
label or glyph. Accent is reserved for actionable emphasis and focus.
Never mark a selected, active or focused item with an accent edge (a stripe,
a one-sided border or an accent outline); the rail's active item is the
`rail-hover` wash with a `rail-accent` icon (`--rail-accent`, the dark-theme
accent, 5.81:1 on `rail-hover`; the rail is dark in both themes).

Segmented controls (view filters, edit/preview, graph scope) are a `role="group"`
of `aria-pressed` buttons: track `rounded-ctl bg-canvas p-1 ring-1 ring-inset
ring-line`, active segment `bg-card font-medium text-ink shadow-card ring-1
ring-line-strong`, inactive `text-mute hover:text-ink`. The ring keeps the active
segment visible in dark mode, where card and track are close.

Focus uses the `--focus` token (solid accent, 6.03:1 on card, 5.07:1 on canvas).
`:focus-visible` draws a 2px `--focus` outline offset by 2px, and the
`focus-ring` utility draws a 2px `--focus` box-shadow. Accent-filled controls
(primary buttons, capture) use `focus-ring-offset` instead, a 2px outline with a
2px gap, because a flush ring in the fill color reads as the control growing.
The desktop rail sets
`--focus` to `--rail-ink` (11.66:1 on the rail); `.dark` inherits the token
because `--accent` switches there. Focus colors must keep 3:1 against their
surface.

Categorical data such as graph tags uses `--graph-1` to `--graph-6`
(`bg-graph-N`, light and dark values), never the `ok`/`warn`/`danger` state
colors. Each graph color keeps 3:1 against card.

## 3. Typography

Self-hosted Pretendard Variable is the UI and reading face; the fallback stack
adds the platform UI faces, Korean system faces and the emoji families.
Monospace is for code, not decorative labels. Existing tokens define 12px
metadata, 13px small copy, 14px controls, 15px body text, 16px reading text,
17px subheads, 20px section heads and 26px page heads. Long-form reading
(Markdown preview, editor, assistant answers) uses `text-read`, 16px on a
28px line, from `--text-read-size` and `--text-read-leading`; `prose-ko` uses
the same pair. Korean labels are never uppercase or letter-spaced, and no
visible label is smaller than 12px. Korean text wraps at word boundaries;
long URLs may break anywhere rather than widen the viewport.

Live Markdown emphasis keeps italic for Latin. Emphasis containing Hangul also
uses a dotted underline in `--mute` at a `0.2em` offset, since Pretendard's
synthetic Hangul italic alone is hard to distinguish. Link underlines remain
solid in `--accent`; emphasis is not an action.

## 4. Space and scroll ownership

Use the existing Tailwind spacing scale and `rounded-ctl` (8px),
`rounded-card` (10px), `rounded-pill` tokens. Desktop rail widths are 64/220px;
mobile top bar and bottom navigation have 52/60px content heights. Safe-area
insets are reserved separately; `--workspace-h` is the remaining pane height.

Without a stored choice the rail starts expanded at 1280px and wider, and
collapsed below; a stored `open`/`closed` choice always wins. The mobile bottom
bar is Home, Inbox, [capture], Notes, More; Inbox carries its count badge,
search stays in the top bar, and the More sheet lists the remaining
destinations in rail order. A new destination is one entry in
`src/components/shell/nav.ts` plus its label in both locales.

Page headers share one recipe: container `mx-auto w-full max-w-6xl px-4 pb-12
pt-5 sm:px-6 lg:px-10 lg:pt-10` (Graph keeps `max-w-7xl`, Settings
`max-w-4xl`), h1 `text-2xl font-semibold tracking-tight lg:text-3xl`, lead
`mt-1 text-sm text-mute`, and no eyebrow above the h1.

Home, search and settings use document scrolling. Editor, graph and chat may
own bounded panes with `min-height: 0`, explicit overflow and dynamic viewport
height. A graph canvas owns pan/zoom; its inspector remains reachable outside
the canvas. On narrow screens, list/detail panes stack or navigate explicitly.
Nothing may scroll underneath a fixed bottom action without safe-area padding.
Sheet bottom padding adds the safe-area inset to its normal spacing.
Graphs fit their first settled layout and canvas resizes; user gestures keep
their chosen view until new data, an explicit reset or a resize.

## 5. Reusable primitives

The public component contracts are documented in `src/components/ui/README.md`.
Reuse Button, Input/Textarea, Dialog/Sheet, EmptyState, Badge/TagBadge, Toast,
Skeleton and the shared shell rather than adding parallel implementations.

`BrandMark` is a rounded tile with 아 from the Korean name 아로 knocked out.
App icons show the glyph in cream on terracotta. The mark uses the existing accent token
and a 20px default; caller size/color utilities override it. Pair the decorative
mark with the localized product name: 아로 / Aro. Installed-app names use
`Aro`, and the source repository is `madrobotnet/aro`. New installations from 2.4.0 use `aro` identifiers;
upgrade compatibility is documented in `docs/UPDATE.md`.

Controls need resting, focus, busy, disabled and failure states. Dialogs use
native modal focus trapping and restore focus to the opener. Destructive actions
need explicit confirmation unless they are reversible from an Undo toast (inbox
discard, snooze and moving a note to the trash act at once and offer Undo);
permanent deletion always confirms. Saving, capture and chat failures preserve input.
Note save failures show their reason visibly beside the retry action.
Icon-only buttons use their square size and zero horizontal padding, without
the text-button padding that would shrink their glyphs.
AI connection dialogs block Escape, backdrop and header dismissal while saving or deleting.
Actual login, capture, settings and error scenarios serve as the primitive state
harness during browser QA.

## 6. Interaction

The shell owns navigation, quick capture and the command palette. Shortcuts must
not intercept editor text or IME composition. Search state belongs in the URL.
Note persistence is serialized; new edits survive an in-flight save. References
open real notes, and missing targets require an explicit creation action.
Chat failures and translated failure text stay visible above the composer,
without moving a reader's position merely for a language switch in normal history.

Use the existing soft easing and meaningful opacity/transform transitions.
Respect reduced motion; a settled graph must stop spending simulation frames.

## 7. Accessibility and responsive checks

Label controls, expose errors as alerts, retain visible keyboard focus, and
provide a keyboard-accessible graph list. Aim for 44px mobile controls. Test
Korean headings, long titles/URLs, empty data, busy/error states and dark mode.
Capture actual desktop and mobile pages; include a tablet reflow check.

Accepted debt: tablet (768px) keeps the mobile shell, because a desktop rail
there needs a shell-wide `lg` to `md` breakpoint change. A first visit without
a stored rail choice animates the rail from 64 to 220px once on load at 1280px
and wider (the server snapshot is collapsed), as it already does for owners who
chose `open`.

## 8. Evidence and boundaries

The acceptance matrix is `docs/INTERFACE-PLAN.md`; captured defects and repairs
are in `docs/REBUILD-AUDIT.md`. Screenshots are evidence, not substitute UI.
The application is private: authentication and deliberate search-engine
exclusion take precedence over a public-site SEO score. Do not claim browser
engines, performance scores, offline support or AI capabilities that were not
actually measured or implemented.

## 9. First-run setup and AI connections

The setup page is a document-scrolling form using the login page's mark,
Pretendard, canvas and card tokens. On desktop, a short installation summary
sits beside the form; on mobile it precedes a single column of controls.
Group installer authorization, the owner's password, and optional AI choices
by purpose. Do not put database URLs, filesystem paths or OAuth tokens in a
public form. An existing installation never presents a password-reset form.

Reuse the same AI connection fields in initial setup and authenticated
settings. Provider and API/Auth selections are labelled native controls.
Explain the selected provider's real login path and distinguish saved
configuration from a verified connection. Optional data sharing requires an
explicit checkbox. Credentials stay in component memory, never localStorage,
URLs or success messages; saved keys are represented only by presence.

Preserve all fields after recoverable failures, identify the failing group,
and prevent duplicate submissions while saving. A completed setup directs
the owner to the ordinary login screen. Cover unconfigured-server, invalid
installer code, validation, saving, completed/locked and configured-credential
states in browser QA, including 390px mobile and 768px tablet layouts.

## 10. Language

Use Korean when the primary preferred system/browser language is Korean,
otherwise English. An explicit `sb_locale` choice wins and persists. Switching
changes labels, errors, accessibility names and document titles in place without
remounting forms, editors or provider login controllers. Preserve drafts and
pending logins. Keep retained failures as codes or bilingual values, not rendered
prose, so they can switch language too.

Existing notes, titles, tags and messages are user data and stay unchanged.
New generated defaults and model instructions use the request locale explicitly.
Dates use the viewer's time zone. Every displayed date or time goes through
`src/lib/i18n/format-date.ts`: `formatDate` (ko `2026-09-29`, en `Sep 29,
2026`), `formatDateTime` (ko `2026-09-29 오후 7:18`, en `Sep 29, 2026, 7:18 PM`),
`formatDayHeading` for a local day key (`9월 29일 화요일` / `Tuesday,
September 29`), `localDateKey` and `calendarDaysAgo`. Times never show
seconds; recent items may use relative labels, and older ones use these
absolute formats. Verify English long labels and Korean text
at desktop, tablet and mobile widths; `한국어` as a language endonym is intentional.
