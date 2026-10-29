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
Never mark selection or an active item with a decorative accent edge (a stripe,
a one-sided border or a selection outline). Keyboard focus is a separate cue,
using the solid focus treatment below. The rail's active item is the
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

Settings reuse purpose groups (h2) and section rows (h3): account/security,
display/language, capture/notes, AI/models, data, then one separated danger zone.
Groups use `space-y-10`; rows use `py-6` and the same label/help-left,
control-right grid on desktop, stacked with `gap-4` on mobile.

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

## 11. Screen briefs and layout contracts

These are repair requirements, not a claim that every existing state passes.
Each region has one current task, three reading priorities and an explicit scroll
owner. A persistent shell Capture action is distinct from the current view's task.
Preserve the existing responsive arrangement unless a recorded defect requires
changing it.

### Setup and login

Primary: complete first-time setup; on the separate login screen, sign in.
Priorities: 1. required credentials, 2. validation or progress, 3. optional AI or
language controls. Required: installer authorization, password confirmation,
recoverable setup input, and the ordinary login redirect. Omit registration,
public database configuration and an existing-installation password-reset form.
Layout: centered public content; setup summary beside its form on desktop and
above it on narrow screens; login is one bounded-width card. The document owns
overflow. Do not create a second page scroller or cover the submit action.

### Shell, command palette and More

Primary: navigate to the selected destination or invoke the selected command.
Priorities: 1. current location, 2. reachable destinations/results, 3. secondary
preferences. Required: skip-to-content, non-color current-route cues, all existing
destinations and meaningful titles. Omit decorative route labels and duplicate
Home quick actions.
Layout: retain the 64/220px rail and 52/60px mobile shell contract, including the
accepted tablet behavior. The main region owns its declared page/pane scrollers;
palette results and an overflowing More sheet scroll inside their own modal.
One modal owns interaction; another command must not act underneath it.

### Capture and confirmations

Primary: save the capture; a confirmation has one explicitly named outcome.
Priorities: 1. draft or affected item, 2. primary action, 3. status and cancellation.
Required: retained drafts, visible in-dialog errors, busy protection, IME-safe
activation and focus restoration. Omit forced categorization and silent loss.
Layout: centered dialog or bottom sheet with one bounded body scroller and
reachable actions. Safe-area padding belongs to the sheet. A confirmation inside
an existing dialog stays within that modal rather than opening a second one.

### Home

Primary: resume useful work; the empty state offers a concrete first action.
Priorities: 1. actionable inbox/today work, 2. recent or pinned notes,
3. resurfacing and counts. Required: actual data, section-specific empty states
and usable retry. Omit marketing heroes, invented statistics and repeated
navigation controls already supplied by the shell.
Layout: centered max-width page grid with document scrolling. Section groups,
not repeated framed cards or accents, establish hierarchy.

### Notes, editor and daily

Primary: open or edit a note; the daily launcher selects a local calendar day.
Priorities: 1. note title/content, 2. persistence state and recovery,
3. metadata, history and connections. Required: list filters/pagination, named
editor modes, visible focus/caret, retained edits and actual save outcomes.
Omit automatic note creation from a reference read and ornamental editor chrome.
Layout: bounded list/detail workspace with explicit list and editor/preview
scrollers and `min-height: 0`. Narrow screens expose the current list or detail
with a reachable return action. Tables and code may scroll locally; the document
must not widen. The editor dock must not obscure content or the caret.

### Missing reference destination

Primary: explicitly create the requested missing note, or return to reading.
Priorities: 1. requested title, 2. lookup outcome, 3. creation/retry action.
Required: authenticated exact title/alias resolution and an explicit creation
boundary. Omit speculative autocomplete matches and mutation during navigation.
Layout: a readable document-scrolling destination using the page contract; no
empty editor is fabricated while lookup is pending or has failed.

### Inbox

Primary: resolve the selected capture, with promotion as the main completion path.
Priorities: 1. editable capture, 2. resolution actions and status,
3. suggestions and list context. Required: Open/Later, retained per-item drafts,
truthful enrichment state, merge/snooze/discard and usable Undo.
Omit mandatory AI decisions and silent resets on selection.
Layout: desktop list/detail workspace with named pane overflow; narrow detail has
a visible Back action. Keep actions within the active detail and preserve draft
ownership when changing selection, filters or language.

### Tasks

Primary: change the selected task's completion state.
Priorities: 1. task text, 2. source note/day, 3. filters and status.
Required: open/done/all views, accurate rollback/refetch and focus after a row
leaves the filtered view. Omit unexplained disabled checkboxes and silent errors.
Layout: document-scrolling grouped list; labels and long note titles wrap without
forcing horizontal page overflow.

### Search

Primary: open the relevant note or source passage.
Priorities: 1. query/refinement, 2. result title and evidence,
3. match/index status. Required: URL-owned query state, a visible query label,
stale-response protection and distinct idle/loading/empty/error outcomes.
Omit claims of learned semantic intelligence where only textual similarity exists.
Layout: centered document-scrolling results; snippets wrap within the reading
column and each result has a coherent navigation target.

### Graph

Primary: inspect a relationship and open its real note.
Priorities: 1. graph or accessible list, 2. selected-node context,
3. scope and camera controls. Required: filters, legend, inspector, keyboard list,
empty/error recovery and explicit missing-note creation. Omit color-only meaning
and fabricated camera telemetry.
Layout: the canvas owns pan/zoom inside its bounded region; the inspector/list
has reachable overflow outside the canvas. Narrow layout must keep both controls
and context reachable. Preserve user camera intent until documented reset/resize.

### Chat

Primary: send a question; during streaming, stop is the active control.
Priorities: 1. readable conversation, 2. composer/status,
3. threads and source citations. Required: truthful availability, retained failed
input, genuine stream completion and an explicit return-to-latest action when
reading earlier content. Omit fabricated answers and forced reading-position jumps.
Layout: bounded thread/history/composer workspace. History owns message scrolling;
the composer remains reachable above the mobile shell and keyboard area. Thread
changes and explicit follow actions, not locale updates, govern reading position.

### Settings and connection forms

Primary: complete the current settings task; a connection dialog saves its draft.
Priorities: 1. purpose and current value, 2. action and status,
3. explanation or advanced options. Required: all six existing purpose groups,
API/Auth paths, explicit sharing consent, retained localized failures, readable
dates and deliberate access revocation. Omit a new global Save action, exposed
stored credentials and unverified connection-success claims.
Layout: max-width document-scrolling groups with desktop label/control columns
and stacked narrow rows. Dialog bodies scroll locally. Capture overlapping middle
regions, not just page top and bottom. Code verification Enter must not save the
outer connection form.

### Recovery notifications

Primary: perform or dismiss the offered recovery action.
Priorities: 1. outcome, 2. actionable recovery, 3. dismiss/status.
Required: persistent action-bearing notifications, pending duplicate protection
and truthful asynchronous outcomes. Omit timer expiry or burst eviction that
removes an available Undo.
Layout: a bounded accessible notification scroller above, not over, required
mobile actions. Non-action notifications may retain the existing bounded policy.

### Offline capture

Primary: save a local draft; sending is a separate reviewed, confirmed action.
Priorities: 1. draft and consent, 2. queue/owner review,
3. help and status. Required: durable request IDs/content, explicit deletion,
failure recovery and bilingual labels/dates. Omit automatic sending or deletion
and any claim that emulation certifies native installed-app behavior.
Layout: standalone document-scrolling form and queue with wrapping content and
reachable actions. Its system-font fallback is deliberate; align semantic color,
geometry and state behavior without adding a framework or font dependency.

### Public reader and protocol outcomes

Primary: read the snapshot; completion/consent pages expose their actual next
decision or return action. Priorities: 1. content/outcome, 2. relevant context,
3. expiry or next action. Required: generic unavailable-share behavior, explicit
consent and non-sensitive failures. Omit app navigation, editing, owner identity,
credentials and fetched resources from the public reader.
Layout: document-scrolling standalone content with a 65ch reading measure.
Every unavailable share gives the same neutral instruction to request a new
link from the sender, without disclosing why this link is unavailable.
Public shares remain
script/asset-isolated; expiry is localized with an explicit UTC label and ISO
only in `datetime`. Their system-font fallback is deliberate, with no font fetch.
Provider completion and invalid consent reuse the existing
public-page geometry, with reachable controls rather than raw protocol text.

### Framework boundaries

Primary: retry when recovery exists, otherwise take the safe return action.
Priorities: 1. clear outcome, 2. next action, 3. non-sensitive diagnostic identifier.
Required: readable 404/error presentation and honest verification limits.
Omit raw exceptions, fake recovery and claims that isolated component rendering
proves the complete framework error lifecycle.
Layout: centered responsive status content with document overflow when needed;
never a blank viewport or inaccessible action outside the visible area.
