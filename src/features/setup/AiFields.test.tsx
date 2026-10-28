import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { AiFields } from "./AiFields";
import { ChatAiFields } from "./ChatAiFields";
import { JevAiFields } from "./JevAiFields";
import { emptyAiForm, type AiFormState } from "./ai-form";
import { renderInLocale } from "./test-locale";

test("keeps both Auth completions queued before the next form render", () => {
  const base = emptyAiForm();
  const initial: AiFormState = {
    chat: { ...base.chat, enabled: true, mode: "auth", provider: "xai" },
    jev: { ...base.jev, enabled: true, mode: "auth", provider: "openrouter" },
  };
  const updates: SetStateAction<AiFormState>[] = [];
  const root: ReactElement<{ children: ReactNode }> = AiFields({
    value: initial,
    onChangeAction: (update) => updates.push(update),
    idPrefix: "qa",
  });
  const children = Children.toArray(root.props.children);
  const chat = children.find((child): child is ReactElement<Parameters<typeof ChatAiFields>[0]> =>
    isValidElement(child) && child.type === ChatAiFields);
  const jev = children.find((child): child is ReactElement<Parameters<typeof JevAiFields>[0]> =>
    isValidElement(child) && child.type === JevAiFields);
  if (!chat || !jev) throw new Error("Both purpose fields must be rendered");

  const chatId = "123e4567-e89b-42d3-a456-426614174010";
  const jevId = "123e4567-e89b-42d3-a456-426614174011";
  chat.props.onChangeAction({ ...initial.chat, authAttemptId: chatId });
  jev.props.onChangeAction({ ...initial.jev, authAttemptId: jevId });
  const result = updates.reduce<AiFormState>(
    (current, update) => typeof update === "function" ? update(current) : update,
    initial,
  );
  expect(result.chat.authAttemptId).toBe(chatId);
  expect(result.jev.authAttemptId).toBe(jevId);
});

test("associates the Jev provider error with its invalid select when validation fails", () => {
  // Given
  const value = { ...emptyAiForm().jev, enabled: true };

  // When
  const markup = renderInLocale(
    <JevAiFields value={value} onChangeAction={() => {}} disabled={false} saved={null}
      errors={{ "jev.provider": "typesafeApiKeyOnly" }} idPrefix="qa" />,
  );

  // Then
  expect(markup).toMatch(/<select id="qa-jev-provider"[^>]*aria-invalid="true"[^>]*aria-describedby="qa-jev-provider-error"/);
  expect(markup).toContain('id="qa-jev-provider-error" role="alert"');
});
