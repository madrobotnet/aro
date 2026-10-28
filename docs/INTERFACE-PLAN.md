# Interface implementation and acceptance

The implementation scope below records the completed v2 rebuild. The repair
acceptance section at the end adds the current interface verification contract;
it does not declare those repairs complete or add a new feature roadmap.
Historical defects, repairs and verification limits remain in
[REBUILD-AUDIT.md](REBUILD-AUDIT.md).

## Implementation scope

The six feature areas shared the same design tokens, UI primitives,
authentication and database contracts. Shared dependencies and cross-feature
changes required integration checks, not just isolated page verification.
Chat compatibility and stream reliability were verified alongside the
interfaces without changing published wire types.

Related references:
[architecture](ARCHITECTURE.md),
[product research](research/ADOPTION.md),
[wire types](../src/lib/types.ts) and
[UI primitives](../src/components/ui/README.md).

### Notes workspace

Scope: `src/features/notes/**`, `src/app/(app)/notes/**` and
`src/app/(app)/daily/**`.

- Implement the note list, search/tag/pinned/archive/trash views and pagination.
- Build a CodeMirror Markdown editor, controls for titles, tags and aliases,
  and a safe GFM preview. `[[` completion uses real note-title results.
- Autosave must retain edits made while a request is running, serialize writes,
  and never replace dirty text with a stale SWR response or another note's body.
  Provide visible saved/saving/failed states and a real retry action.
- Following a wikilink opens the existing note or explicitly creates the missing
  target through `/api/notes/by-title`. Preserve display labels.
- Show backlinks, outgoing/unresolved links, unlinked mentions and related notes.
  Related-note vectors represent textual similarity, not learned semantic AI.
- Use the graph component's existing `LocalGraph({noteId, depth?, height?})` contract.
- Connect pin, archive, trash, restore, purge and attachment upload controls to
  their actual APIs.
- `/daily` creates or opens the note for the selected local calendar date.
- Test save sequencing at a meaningful integration boundary where practical;
  don't assert prose or mock away the persistence behavior under test.

Browser acceptance: create `QA Source` containing `[[QA Target]]`, follow the
target, confirm the backlink, edit while a save is pending, reload and confirm the
latest body. Check tag filters, trash/restore and mobile editor overflow.

### Capture and inbox

Scope: `src/features/capture/**`, `src/features/inbox/**` and
`src/app/(app)/inbox/**`.

- Replace the CaptureDialog stub while preserving `open`/`onOpenChange` props.
- Capture text or URLs without requiring categorization. Preserve input on
  failure and show confirmed server success before clearing the form.
- Connect inbox selection, promotion and confirmed discard to their real endpoints.
- Keyboard navigation and triage must not intercept typing in forms or editors.
- Distinguish pending, unavailable and failed Jev suggestions; apply proposed tags
  only when the user selects them. Refresh inbox badges and affected caches.
- Provide loading, empty and retry states without fake sample data.

Browser acceptance: open capture from the shell, save a unique text item, see it
in Inbox, promote it, and open the resulting persistent note. Repeat promotion
without producing a duplicate. Exercise this without AI credentials.

### Knowledge graph

Scope: `src/features/graph/**` and `src/app/(app)/graph/**`.

- Replace LocalGraph and build the full graph with `react-force-graph-2d`,
  client-only loading and a correctly sized responsive canvas.
- Consume the real GraphData response; don't substitute a hardcoded node map.
- Support global/local mode, depth 1/2/3, tag filtering, tag nodes and orphans.
- Highlight hovered/selected neighbors, scale note size by degree, and use
  stable tag colors with an explanatory legend.
- Support pan/zoom, fit/reset, node dragging/pinning and clearing the selection.
- A selected-node inspector must open the actual note; unresolved targets have
  an explicit create/open action. Provide an accessible list alternative.
- Clone data before handing it to the mutating force-graph library. Stop settled
  simulations and respect reduced motion. Don't claim unmeasured performance.

Browser acceptance: a seeded graph has real nodes and edges; selecting a node
shows its neighbors and opens that note. Local depth changes the fixture's
visible neighborhood. Filters and reset work at desktop and mobile widths.

### Search

Scope: `src/features/search/**` and `src/app/(app)/search/**`.

- Use URL query state and the actual `/api/search` response.
- Show ranked titles, snippets, tags and timestamps with keyboard-accessible
  note navigation. Prevent slow responses to older queries from replacing newer results.
- Support tag filters, no-results, empty-query, loading and retry states.
- Translate the legacy `matchedBy: "semantic"` token to truthful textual
  similarity copy. Don't advertise a learned embedding model.

Browser acceptance: search the captured note's exact title, open the expected
result, verify a nonsense query has no results, and test a Korean query.

### Cited chat

Scope: `src/features/chat/**` and `src/app/(app)/chat/**`.

- Implement a persistent thread list with create, rename and delete actions,
  and retain message history.
- Check `/api/chat/status`; unavailable configuration must be visible rather
  than a fabricated answer or an unexplained disabled control.
- Parse real incremental SSE `citations`, `delta`, `done` and `error` events,
  including fragmented UTF-8/CRLF boundaries. A stream ending without `done` is
  not a successful answer.
- Preserve the user's text on failures; prevent duplicate sends and abort an
  obsolete stream when switching threads.
- Render Markdown safely and provide source cards linked to actual note IDs.
  Never create citations in the client or treat retrieved text as HTML.
- Add deterministic parser regression tests with realistic fragmented frames.

Browser acceptance: create a thread, send a note-grounded question, observe
streaming and open a real citation. Reload to recover history. Also verify the
unconfigured/error state without inventing an assistant message.

### Home and settings

Scope: `src/features/home/**`, `src/features/settings/**`,
`src/app/(app)/page.tsx` and `src/app/(app)/settings/**`.

- Replace the temporary landing page with real HomeData: inbox preview, recent/pinned
  notes, today's note, resurfacing and accurate counts.
- Prioritize useful actions and reading hierarchy over promotional hero cards.
  Empty sections should invite an action, not show synthetic statistics.
- Wire theme controls to the existing shell theme store.
- Show actual session expiry and use the real logout/revoke-all endpoints with
  confirmation where appropriate.
- Explain optional AI and installation behavior accurately; don't add unwired
  export, backup, offline or configuration buttons.

Browser acceptance: dashboard counts reflect seed data; notes open and daily
capture works. The theme survives navigation/reload; logout returns to login and
revoked sessions cannot access protected routes.

## Final verification requirements

Run `bun run typecheck`, `bun run lint`, relevant Bun tests, and
`bun run build`. Record exact failures without suppressing them.
Verify all intended route files exist and no feature stub remains.
Execute the complete 1440×900 / 390×844 browser matrix against the production
build, inspect every screenshot and fix observed defects. Stop QA servers and
browsers and record cleanup. Keep production data, deployment and authentication
outside the QA environment.

## Chat compatibility and stream reliability

Scope: `src/server/chat/**` and its tests.
Legacy stored citations used `{noteId, title, snippet?}`; the rebuilt reader
required `{index, noteId, title, excerpt}`. The compatibility requirement was to
preserve old conversations by mapping legacy citations to the new wire shape
without rewriting stored data.

At the start of the rebuild, the provider adapter treated a delta-only EOF as
success. The repair requirements were to accept only a genuine successful
Responses completion, reject failed, incomplete or truncated streams, and
verify that service rollback remained intact. Concurrent expired-token sends
had to share refresh for the same auth file, following the prior implementation's
single-flight pattern. Refreshed auth had to be persisted atomically while
preserving unrelated file fields. All tests used deterministic local streams
and files, with no real credentials or upstream calls.

Integration checks also covered note/search fingerprint alignment and shared-shell
logout failure feedback. These repairs didn't change frontend response types.

## Current repair acceptance

The screen briefs and Layout contracts in DESIGN.md section 11 define the current task, reading priorities, required content, deliberate omissions and scroll owners. Repairs preserve the existing product and data contracts; this section is a verification contract, not a completion claim.

### Case coverage

| Cases | Required coverage |
| --- | --- |
| S001-S005 | Setup/login, real route matrices, native submission and hydrated recovery. |
| S006-S014 | Synthetic fixtures, editor caret, reference read/create separation, modal ownership, composition, triage drafts and detached chat reading. |
| S015-S019 | Modal-contained recovery, persistent Undo, retained localized settings failures, every control consumer and actual motion sequences. |
| S020-S024 | Wayfinding/theme-storage failure, API/Auth Enter boundaries, offline protection, public capability isolation and graph controls. |
| S025-S029 | Workbench/reflow/calendar/media, deliberate revocation, settings lifecycle, protocol/framework boundaries and editor measurement/remount. |

S027 covers existing template/import/export/session flows. S028 covers existing provider completion, OAuth consent and framework boundaries. These fill the two previously unassigned case IDs without adding product features. Each run freezes its synthetic fixture, actual route/control selectors, action, expected signal and source identity before edits. Historical fixture IDs are not assumed to remain valid.

### Evidence protocol

- Use owned synthetic data and localhost runtimes; do not inherit owner credentials or production databases.
- Capture light/dark and Korean/English at 390x844 (touch/DPR 3), 768x1024 (touch/DPR 2), 1440x900 and 1920x1080 (DPR 1). Record actual metrics, locale/theme, rail preference, fonts and document/nested scroll owners. Inspect every PNG, including overlapping middle slices.
- Use untouched matching source for before images. Keep raw captures and source-bound manifests outside git; image differences must retain dimensions, alpha and every changed region. A reconstructed before image is not evidence.
- Subscribe before triggering requests, DOM changes or animations. Hold/release requests explicitly; use controlled clocks for expiry and actual effect timing for motion. Do not sleep for readiness or accept an empty control list as proof.
- Inspect keyboard order, composition guards and the accessibility tree. Label native Windows/iPhone/Slack and screen-reader limits honestly; emulation does not certify them.
- Report each condition below as PASS, FAIL, N/A with a reason, or UNVERIFIED, with named current evidence. An unchanged pre-existing issue stays open under its repair owner. A failed external gate is never relabelled PASS.
- Run exact-tree typecheck, zero-warning lint, full database-backed tests, production build and Docker build before publication. Record any explicitly authorized narrow exception with its baseline proof and actual failure. Review current source and evidence before opening PRs; never merge or deploy as part of interface QA.

### Detailed visual conditions

| ID | Agent-executed mechanism or bounded adaptation |
|---|---|
| A1 | Compare each screen with its declared centered/grid anchor and primary reading region. |
| A2 | Inspect viewport edges and PNG alpha/compositing; compare document/body bounds with the viewport. |
| A3 | Measure symmetric gutters and desktop prose measure; adapt the 45-75ch preference to available phone width. |
| A4 | Check safe-area CSS and bounds under available emulated insets; label native notch/home-indicator behavior unverified. |
| A5 | At mobile/touch metrics compare innerWidth/clientWidth and inspect overlay scrolling; never hide scrollbars to pass. |
| A6 | Log document plus actual overflow owners for each region and inspect sticky/floating controls at every scroll end. |
| A7 | Compare shared left/right edges and computed spacing with existing tokens, allowing border/raster rounding. |
| A8 | Inspect grouping and separation with full required content, especially Settings middle sections and triage. |
| A9 | Check document overflow and element clipping at four widths, long labels/URLs, empty/populated states and reflow. |
| A10 | Inspect partial content/scrollbar/continuation cues on every overflowing region. |
| A11 | N/A native macOS window chrome; still check web reflow and the accepted responsive rail. |
| A12 | Require a Layout line per changed region and match its named scrollers/anti-patterns to the recorded probe. |
| B1 | Compare the single view-primary action with its brief; distinguish the persistent shell capture action from local view scope. |
| B2 | Open each destructive confirmation; no implicit destructive submit, Cancel available, explicit outcome-styled action. |
| B3 | Read page/document titles and chrome headings; retain meaningful note titles without modifying user Markdown. |
| B4 | Inspect priorities 1-3 in first-viewport reading order and ensure secondary detail does not displace them. |
| B5 | Inspect semantic accent use; reject decorative state stripes, not functional focus-token outlines. |
| B6 | Compare typography hierarchy across paired themes using the pinned local scale and intentional standalone font exception. |
| B7 | Check every required field/datum/control against its brief; no missing or merged required content. |
| C1 | Adapt to Aro: 16px/28px reading text and 12px visible-label floor; do not import native 17/15pt minima. |
| C2 | Inspect actual date/time and error output; public no-script expiry uses explicitly labelled UTC and ISO only in datetime. |
| C3 | Inspect localized outcome labels and consistent casing; native browser control wording is not fabricated app copy. |
| C4 | Run 200% equivalent reflow/large-text checks and inspect every screenshot for clipping, ellipsis and extreme headings. |
| C5 | Read every Korean/mixed-script frame for syllable/particle/auxiliary/citation breaks, tofu and clipped baselines. |
| C6 | Force empty/loading/unavailable/error cases and verify a contextual next action and preserved input where promised. |
| C7 | Verify visible labels and programmatic associations; contextual search headings count only when visibly and explicitly associated. |
| C8 | Use real selection on useful errors, URLs and identifiers; confirm no raster/text-selection substitute. |
| D1 | Measure actual coarse-pointer hit rectangles including pseudo-elements; 44px aim, no overlap, useful spacing. |
| D2 | Adapt to the existing 52px top/60px bottom web shell; all tabs reachable and active route has a non-color cue. |
| D3 | Inspect toolbar groups, primary action and standard back/close controls at all widths. |
| D4 | Probe adjacent action rectangles and keyboard/pointer activation; no dead gaps or overlapping hit regions. |
| E1 | Compare real rendered light/dark pairs and record actual root/media/computed colors, not filename assumptions. |
| E2 | Compute sRGB contrast for actual semantic text/placeholder/focus/icon/control states; no compliance claim from pixels alone. |
| E3 | Inspect non-color status/selection/focus cues and the accessibility tree. |
| E4 | Compare semantic state versus categorical graph color use across all consumers. |
| E5 | Scroll real text beneath translucent bars and inspect legibility at top/middle/end. |
| E6 | Test system/light/dark preference and a storage-rejection case; standalone no-control pages follow OS media. |
| F1 | Compare the actual SVG/icon family and standard back glyphs; preserve the owner brand. |
| F2 | Inspect token-driven spacing/radii and deliberate standalone exceptions; do not impose generic native geometry. |
| F3 | Capture every sibling consumer of changed primitives, not a representative sample. |
| F4 | Preserve existing brand elements; no developer badge or promotional branding is added to public reading content. |
| F5 | Compare neutral/wash selection and solid functional focus; no decorative accent state edge. |
| F6 | Inspect standard icon placement and actual accessible names/tooltips. |
| F7 | Test one interactive modal owner and handoffs; use web Dialog/Sheet shapes, not Apple-native shape mandates. |
| G1 | Inventory every animation cause; ensure settled graph simulation and no decorative permanent loop. |
| G2 | Capture rest/mid/settled geometry; explicitly retain the documented initial rail behavior rather than call it an unnoticed regression. |
| G3 | Interrupt actual transitions with input/dismissal and verify the current action wins without queued blockage. |
| G4 | Repeat with reduced motion: positional effects reduced, useful opacity/progress retained, no global 0.01ms kill. |
| G5 | Observe action acknowledgment and held-request progress via events/timelines; do not fabricate percentages or sleep for readiness. |
| G6 | Record first-load/layout-shift evidence including fonts/media; separate accepted rail behavior and unknown external-image dimensions. |
| G7 | Inspect motion sequences for flashing/large oscillation and reading interruption. |
| H1 | Enumerate and execute every applicable empty/loading/error/offline state; do not invent unsupported offline features. |
| H2 | Hold actual requests and inspect immediate status/placeholder plus meaningful continuing progress in both motion modes. |
| H3 | Reject real requests and verify in-place cause/recovery; modal failures must be descendants of the owning dialog. |
| H4 | Inspect app-authored confirmations for concise situation/outcome/Cancel, appropriate initial focus and reachable content. |
| H5 | Capture hover/pressed/focus/disabled/busy/error for every changed control family and custom consumer. |
| H6 | Exercise modal exits, protected busy states and unsaved-work retention; no automatic silent discard or stacked task modal. |
| H7 | Exercise existing stop/cancel paths; where cancellation is unsafe, verify busy dismissal lock and explanation rather than invent cancellation. |
| H8 | Inspect explicit setup/data-sharing/local-storage consent and actual owner-review/send boundaries using controlled fixtures. |
| H9 | Preserve the private login requirement and masked non-prefilled secrets; distinguish setup retention from existing login policy. |
| H10 | Test workspace/palette/merge search scope, clear/query/refinement/results/failure; do not add history or suggestions as a generic mandate. |
| H11 | Inspect real Settings purpose groups, labels and current selections; no native mac settings-window mandate. |
| I1 | Traverse keyboard order and visible focus, including skip, dialog opener restoration and editor caret clipping. |
| I2 | Test Escape, safe Enter, shell commands, ordinary editing and two independent composition guard conditions. |
| I3 | Inspect the current accessibility tree: named inputs/icons, meaningful image alternatives, headings and landmarks; do not claim a screen-reader run. |
| I4 | Exercise graph/list/inspector and visible close/back alternatives to gestures. |
| I5 | N/A unless an actual autoplaying media surface is found; no new media capability. |
| J1 | N/A native macOS chrome/menu-bar contracts; this is web UI on Linux. |
| J2 | Check compact overlay reflow and field inputmode/type; keep the existing keyboard-open top dock and label native iOS limits. |
