import { expect, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { AiAuthPanel } from "./AiAuthPanel";
import { ChatAuthFields } from "./ChatAuthFields";
import { emptyChatForm, type ChatFormState } from "./connection-form";
import { captureTree } from "./test-locale";

test("clears the ready attempt and consent when the Copilot domain changes", () => {
  // Given
  const patches: Partial<ChatFormState>[] = [];
  let abandoned = 0;
  const tree = captureTree(ChatAuthFields, {
    chat: {
      ...emptyChatForm(), mode: "auth", provider: "github-copilot",
      enterpriseDomain: "old.example.com", authAttemptId: "ready-attempt", consent: true,
    },
    setChatAction: (patch) => patches.push(patch),
    abandonReadyAttemptAction: () => { abandoned += 1; },
    disabled: false, saved: null, errors: {}, idPrefix: "qa",
  });
  if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected Auth fields");
  const domainGroup = Children.toArray(tree.props.children).find((node) =>
    isValidElement<{ children: ReactNode }>(node) && node.type === "div");
  if (!isValidElement<{ children: ReactNode }>(domainGroup)) throw new Error("Expected domain group");
  const domain = Children.toArray(domainGroup.props.children).find((node) =>
    isValidElement(node) && node.type === "input");
  if (!isValidElement<{ onChange: (event: { readonly target: { readonly value: string } }) => void }>(domain)) {
    throw new Error("Expected domain input");
  }
  const target = { value: "new.example.com" };

  // When
  domain.props.onChange({ target });

  // Then
  expect(abandoned).toBe(1);
  expect(patches).toEqual([{ enterpriseDomain: "new.example.com", authAttemptId: undefined, consent: false }]);
});

test.each([
  { domain: "saved.example.com", expected: true },
  { domain: "other.example.com", expected: false },
])("scopes the saved credential when the Copilot domain is $domain", ({ domain, expected }) => {
  // Given
  const tree = captureTree(ChatAuthFields, {
    chat: { ...emptyChatForm(), mode: "auth", provider: "github-copilot", enterpriseDomain: domain },
    setChatAction: () => {}, abandonReadyAttemptAction: () => {}, disabled: true,
    saved: {
      chat: {
        mode: "auth", provider: "github-copilot", model: "gpt-6-luna",
        enterpriseDomain: "saved.example.com", hasApiKey: false, hasCredential: true,
      },
      jev: null, profiles: [], chatId: null, jevId: null,
      chatManagedByEnvironment: false, jevManagedByEnvironment: false,
    },
    errors: {}, idPrefix: "qa", setupToken: "test-installer-token",
  });
  if (!isValidElement<{ children: ReactNode }>(tree)) throw new Error("Expected Auth fields");

  // When
  const panel = Children.toArray(tree.props.children).find((node) =>
    isValidElement(node) && node.type === AiAuthPanel);

  // Then
  if (!isValidElement<Parameters<typeof AiAuthPanel>[0]>(panel)) throw new Error("Expected Auth panel");
  expect(panel.props).toMatchObject({
    provider: "github-copilot", enterpriseDomain: domain, disabled: true,
    setupToken: "test-installer-token", hasSavedCredential: expected,
  });
});
