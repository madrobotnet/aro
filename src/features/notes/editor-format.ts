import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";

export type FormatAction = "heading" | "bullet" | "task" | "code" | "wiki";

/** Pure transaction builder; the view owns composition guarding and dispatch. */
export function formatTransaction(state: EditorState, action: FormatAction): TransactionSpec {
  const range = state.selection.main;
  if (action === "wiki" || action === "code") {
    const selected = state.sliceDoc(range.from, range.to);
    const insert = action === "wiki" ? `[[${selected}` : `\`${selected}\``;
    return {
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.range(range.from + (action === "wiki" ? 2 : 1), range.to + (action === "wiki" ? 2 : 1)),
      userEvent: "input",
      scrollIntoView: true,
    };
  }
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to);
  const changes = [];
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number);
    const match = /^( *)(#{1,6} |[-*+] (?:\[[ xX]\] )?)/.exec(line.text);
    const indent = match?.[1] ?? /^ */.exec(line.text)?.[0] ?? "";
    const old = match?.[2] ?? "";
    let prefix: string;
    switch (action) {
      case "heading": prefix = old === "## " ? "### " : old === "### " ? "" : "## "; break;
      case "bullet": prefix = old === "- " ? "" : "- "; break;
      case "task": prefix = old === "- [ ] " || old === "- [x] " || old === "- [X] " ? "" : "- [ ] "; break;
    }
    changes.push({ from: line.from + indent.length, to: line.from + indent.length + old.length, insert: prefix });
  }
  const changeSet = state.changes(changes);
  return {
    changes: changeSet,
    selection: EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1)),
    userEvent: "input",
    scrollIntoView: true,
  };
}
