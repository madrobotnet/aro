import { expect, test } from "bun:test";
import { Children, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { AuthCodeField } from "./AiAuthPanel";
import { AI_COPY } from "./ai-copy";
import { captureTree, hangulIn, html, renderInLocale } from "./test-locale";

type InputProps = { readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void };

function findInput(node: ReactNode): ReactElement<InputProps> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === "input") return child as ReactElement<InputProps>;
    const nested = findInput(child.props.children);
    if (nested) return nested;
  }
  return null;
}

const props = (onSubmitAction: () => void) => ({
  id: "qa-google-code",
  value: "4/0Abc",
  error: null,
  submitting: false,
  onChangeAction: () => {},
  onSubmitAction,
});

function pressEnter(input: ReactElement<InputProps>, isComposing: boolean, keyCode = 13) {
  let prevented = false;
  input.props.onKeyDown({
    key: "Enter",
    keyCode,
    nativeEvent: { isComposing },
    preventDefault: () => { prevented = true; },
  } as unknown as KeyboardEvent<HTMLInputElement>);
  return prevented;
}

test("Enter in the Google code field submits the code instead of the surrounding form", () => {
  let submissions = 0;
  const input = findInput(captureTree(AuthCodeField, props(() => { submissions += 1; })));
  if (!input) throw new Error("The code field must render an input");

  expect(pressEnter(input, true)).toBe(false);
  expect(submissions).toBe(0);
  expect(pressEnter(input, false)).toBe(true);
  expect(submissions).toBe(1);
});

test("Enter with IME keyCode 229 does not submit the Google authorization code", () => {
  let submissions = 0;
  const input = findInput(captureTree(AuthCodeField, props(() => { submissions += 1; })));
  if (!input) throw new Error("The code field must render an input");

  expect(pressEnter(input, false, 229)).toBe(false);
  expect(submissions).toBe(0);
});

test("the Google code field adds no nested form, submit button or form-data entry", () => {
  const markup = renderInLocale(<AuthCodeField {...props(() => {})} />);
  const buttons = markup.match(/<button\b[^>]*>/g) ?? [];

  expect(markup).not.toContain("<form");
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) expect(button).toContain('type="button"');
  expect(markup).not.toMatch(/<input\b[^>]*\bname=/);
  expect(markup).toContain('for="qa-google-code"');
  expect(markup).toMatch(/<input\b[^>]*\bautoComplete="off"/);
});

test("the code field follows the current locale", () => {
  const english = renderInLocale(<AuthCodeField {...props(() => {})} />, "en");
  expect(hangulIn(english)).toEqual([]);
  expect(english).toContain(html(AI_COPY.en.auth.codeSubmit));
  expect(renderInLocale(<AuthCodeField {...props(() => {})} />, "ko")).toContain(html(AI_COPY.ko.auth.codeSubmit));
});
