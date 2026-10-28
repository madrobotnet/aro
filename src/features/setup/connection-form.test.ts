import { expect, test } from "bun:test";
import { buildChatConnection, emptyChatForm, type ChatFormState, type HeaderAction } from "./connection-form";

const headerCases: {
  readonly action: HeaderAction;
  readonly headers: Readonly<Record<string, string>> | undefined;
}[] = [
  { action: "retain", headers: undefined },
  { action: "clear", headers: {} },
  { action: "replace", headers: { "x-tenant": "new" } },
];

test.each(headerCases)("preserves the $action header operation when building a custom API connection", ({ action, headers }) => {
  // Given
  const state: ChatFormState = {
    ...emptyChatForm(), provider: "openai-compatible", keyless: true, consent: true,
    baseUrl: "http://host.docker.internal:11434/v1/", headerAction: action,
    headersJson: '{"X-Tenant":"new"}',
  };

  // When
  const result = buildChatConnection(state, null);

  // Then
  expect(result).toEqual({
    ok: true,
    connection: {
      mode: "api", provider: state.provider, model: state.model, apiKey: "",
      baseUrl: "http://host.docker.internal:11434/v1", apiFormat: "chat-completions",
      ...(headers === undefined ? {} : { headers }),
    },
  });
});

test.each([
  { text: "", expected: undefined },
  { text: " 1 ", expected: 1 },
  { text: "128000", expected: 128_000 },
] as const)("parses output limit $text when the API options are valid", ({ text, expected }) => {
  // Given
  const state = { ...emptyChatForm(), apiKey: "test-key", consent: true, maxOutputTokens: text };

  // When
  const result = buildChatConnection(state, null);

  // Then
  expect(result).toEqual({
    ok: true,
    connection: {
      mode: "api", provider: state.provider, model: state.model, apiKey: "test-key",
      ...(expected === undefined ? {} : { maxOutputTokens: expected }),
    },
  });
});

test.each(["0", "1.5", "128001", "invalid"])("rejects output limit %s when outside the API range", (maxOutputTokens) => {
  // Given
  const state = { ...emptyChatForm(), apiKey: "test-key", consent: true, maxOutputTokens };

  // When
  const result = buildChatConnection(state, null);

  // Then
  expect(result).toEqual({ ok: false, errors: { maxOutputTokens: "maxOutputTokensRange" } });
});

test("retains all field failures when API parsing follows model and consent validation", () => {
  // Given
  const state: ChatFormState = {
    ...emptyChatForm(), provider: "openai-compatible", model: "", baseUrl: "",
    headerAction: "replace", headersJson: "{", maxOutputTokens: "0",
  };

  // When
  const result = buildChatConnection(state, null);

  // Then
  expect(result).toEqual({
    ok: false,
    errors: {
      model: "modelFormat", consent: "chatConsent", baseUrl: "baseUrlRequired",
      apiKey: "apiKeyOrKeyless", headers: "headersNotObject", maxOutputTokens: "maxOutputTokensRange",
    },
  });
});
