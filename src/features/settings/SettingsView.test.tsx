import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { captureTree } from "@/features/setup/test-locale";
import { AgentsSection } from "./AgentsSection";
import { AiConnections } from "./AiConnections";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { ExportSection } from "./ExportSection";
import { ImportSection } from "./ImportSection";
import { Section, SettingsGroup } from "./SettingsSection";
import { SessionDangerSection, SessionSection } from "./SettingsSession";
import { SettingsView } from "./SettingsView";
import { TemplatesSection } from "./TemplatesSection";
import { ConnectionProfileDialog } from "./ConnectionProfileDialog";
import { Button, Dialog } from "@/components/ui";

type GroupProps = { id: string; children: ReactNode; danger?: boolean };
function groups(node: ReactNode): ReactElement<GroupProps>[] {
  return Children.toArray(node).flatMap(child => {
    if (!isValidElement<GroupProps>(child)) return [];
    return child.type === SettingsGroup ? [child] : groups(child.props.children);
  });
}

test("settings retains every section in purpose groups with global session revocation last", () => {
  const sections = groups(captureTree(SettingsView, {}));
  expect(sections.map(section => section.props.id)).toEqual([
    "settings-account-group", "settings-display-group", "settings-notes-group",
    "settings-ai-group", "settings-data-group", "settings-danger-group",
  ]);
  const rows = sections.map(section => Children.toArray(section.props.children));
  expect(rows.map(row => row.length)).toEqual([2, 3, 2, 1, 4, 1]);
  const types = rows.map(row => row.flatMap(child => isValidElement(child) ? [child.type] : []));
  expect(types[0]).toEqual([SessionSection, AgentsSection]);
  expect(types[2]?.[0]).toBe(TemplatesSection);
  expect(types[3]).toEqual([AiConnections]);
  expect(types[4]?.slice(1)).toEqual([ExportSection, ImportSection, DiagnosticsSection]);
  expect(types[5]).toEqual([SessionDangerSection]);
  expect(sections.filter(section => section.props.danger)).toHaveLength(1);
  expect(sections.at(-1)?.props.danger).toBe(true);
});

test("group and row headings expose a labelled hierarchy without extra scroll containers", () => {
  const markup = renderToStaticMarkup(
    <SettingsGroup id="group" title="Group">
      <Section id="row" title="Row" description="Help"><button>Control</button></Section>
    </SettingsGroup>,
  );
  expect(markup).toContain('aria-labelledby="group"');
  expect(markup).toContain('<h2 id="group"');
  expect(markup).toContain('aria-labelledby="row"');
  expect(markup).toContain('<h3 id="row"');
  expect(markup).not.toContain("overflow");
});

test("connection Save belongs to its real form and composition cannot implicitly submit", () => {
  // Given a new connection dialog using the same form boundary as the browser.
  const tree = captureTree(ConnectionProfileDialog, {
    open: true, purpose: "chat", profile: null, connections: [],
    onOpenChangeAction: () => {}, onSavedAction: () => {},
  });
  if (!isValidElement<{ children: ReactNode; footer: ReactNode }>(tree) || tree.type !== Dialog) {
    throw new Error("Expected the connection dialog");
  }
  const form = Children.toArray(tree.props.children).find(child =>
    isValidElement(child) && child.type === "form");
  if (!isValidElement<{ id: string; onKeyDown: (event: {
    key: string; keyCode: number; nativeEvent: { isComposing: boolean }; preventDefault: () => void;
  }) => void }>(form)) throw new Error("Expected a real form");
  const save = Children.toArray(tree.props.footer).flatMap(child =>
    isValidElement<{ children?: ReactNode }>(child) ? Children.toArray(child.props.children) : [])
    .find(child => isValidElement<{ type?: string }>(child) && child.type === Button && child.props.type === "submit");
  // When inspecting the machine-consumed association, then Save submits exactly this form.
  if (!isValidElement<{ form: string }>(save)) throw new Error("Expected Save submit button");
  expect(save.props.form).toBe(form.props.id);
  for (const [isComposing, keyCode, expected] of [[true, 13, true], [false, 229, true], [false, 13, false]] as const) {
    let prevented = false;
    form.props.onKeyDown({ key: "Enter", keyCode, nativeEvent: { isComposing }, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(expected);
  }
});
