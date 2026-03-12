import { describe, expect, it } from "vitest";
import {
  resolveNativeSenderInputText,
  resolveNativeSenderInvocationMode
} from "../../../injected/cursor-help-native-sender";

describe("cursor-help-native-sender", () => {
  it("treats ChatInput onSubmit as text-first sender when signature carries message args", () => {
    expect(resolveNativeSenderInvocationMode("ChatInput", "onSubmit", 3)).toBe("submit_text");
    expect(resolveNativeSenderInvocationMode("PromptComposer", "onSubmit", 1)).toBe("submit_text");
  });

  it("rejects generic onSubmit handlers that are not chat-native senders", () => {
    expect(resolveNativeSenderInvocationMode("form", "onSubmit", 1)).toBeNull();
    expect(resolveNativeSenderInvocationMode("SearchBox", "onSubmit", 0)).toBeNull();
  });

  it("keeps only text-accepting send-like actions for non-onSubmit dispatcher props", () => {
    expect(resolveNativeSenderInvocationMode("MessageComposer", "sendMessage", 1)).toBe("sender_action");
    expect(resolveNativeSenderInvocationMode("Composer", "handleSubmit", 0)).toBeNull();
    expect(resolveNativeSenderInvocationMode("Composer", "onChange", 1)).toBeNull();
  });

  it("prefers the latest user prompt over the compiled prompt for native sender input", () => {
    expect(resolveNativeSenderInputText("Search docs", "compiled prompt")).toBe("Search docs");
    expect(resolveNativeSenderInputText("   ", "compiled prompt")).toBe("compiled prompt");
    expect(resolveNativeSenderInputText("", "")).toBe("Continue");
  });
});
