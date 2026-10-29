import { EditorView } from "@codemirror/view";

export const liveTheme = EditorView.baseTheme({
  ".cm-live-h1": { fontSize: "var(--text-2xl)", fontWeight: "700" },
  ".cm-live-h2": { fontSize: "var(--text-xl)", fontWeight: "700" },
  "& .cm-line.cm-live-setext-hidden": { height: "0", minHeight: "0", lineHeight: "0", overflow: "hidden" },
  ".cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "var(--text-lg)", fontWeight: "600" },
  ".cm-live-strong": { fontWeight: "700" },
  ".cm-live-em": { fontStyle: "italic" },
  ".cm-live-em-ko": { textDecoration: "underline dotted var(--mute)", textUnderlineOffset: "0.2em" },
  ".cm-live-strike": { textDecoration: "line-through" },
  ".cm-live-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "0.15em", cursor: "pointer" },
  ".cm-live-link:focus-visible": { outline: "2px solid var(--focus)", outlineOffset: "2px" },
  ".cm-link-popover": { position: "fixed", inset: "auto", margin: "0", maxWidth: "calc(100vw - 16px)", fontFamily: "var(--font-sans)" },
  ".cm-live-code": { fontFamily: "var(--font-mono)", backgroundColor: "var(--desk)", borderRadius: "var(--radius-ctl)" },
  ".cm-live-tag": { color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-pill)" },
  ".cm-live-quote": { borderLeft: "2px solid var(--line-strong)", paddingLeft: "1rem", color: "var(--mute)" },
  ".cm-live-bullet": { color: "var(--mute)" },
  ".cm-live-task": { display: "inline-flex", alignItems: "center", minHeight: "var(--text-read-leading)", verticalAlign: "middle", marginRight: "0.5rem" },
  ".cm-live-task input": { width: "1rem", height: "1rem", margin: "0", accentColor: "var(--accent)", cursor: "pointer" },
  ".cm-live-done": { color: "var(--mute)", textDecoration: "line-through" },
  ".cm-live-wiki": { color: "var(--accent)", backgroundColor: "var(--accent-soft)", borderRadius: "var(--radius-ctl)", padding: "0.125rem 0.25rem", cursor: "text", boxDecorationBreak: "clone" },
  "& .cm-line.cm-live-fence": { backgroundColor: "var(--desk)", fontFamily: "var(--font-mono)", padding: "0 0.5rem" },
  ".cm-live-code-info": { fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)", color: "var(--mute)", fontWeight: "600" },
});

