// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  inspectCursorHelpNativeModelCatalog,
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

  it("reads model catalog from React props even when popup layout is collapsed", () => {
    document.body.innerHTML = `<textarea aria-label="Chat message"></textarea>`;
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    Object.defineProperty(textarea, "__reactFiber$test", {
      configurable: true,
      value: {
        type: { displayName: "ChatInput" },
        memoizedProps: {
          selectedModel: "Claude Sonnet 4.6",
          availableModels: [
            { label: "Claude Sonnet 4.6", selected: true },
            { label: "Gemini 2.5 Pro" },
            { label: "GPT-5" }
          ]
        },
        return: null
      }
    });

    const catalog = inspectCursorHelpNativeModelCatalog(document);

    expect(catalog.selectedModel).toBe("Claude Sonnet 4.6");
    expect(catalog.availableModels).toEqual([
      "Claude Sonnet 4.6",
      "Gemini 2.5 Pro",
      "GPT-5"
    ]);
  });

  it("walks through generic state containers to find nested model catalog", () => {
    document.body.innerHTML = `<textarea aria-label="Chat message"></textarea>`;
    const textarea = document.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    Object.defineProperty(textarea, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 120,
        top: 120,
        left: 0,
        right: 200,
        bottom: 156,
        width: 200,
        height: 36,
        toJSON: () => ({})
      })
    });
    Object.defineProperty(textarea, "__reactFiber$nested", {
      configurable: true,
      value: {
        type: { displayName: "ChatInput" },
        memoizedProps: {
          composerState: {
            modelSwitcher: {
              current: {
                label: "Claude Sonnet 4.6"
              },
              entries: [
                { label: "Claude Sonnet 4.6", isSelected: true },
                { label: "Gemini 2.5 Pro" }
              ]
            }
          }
        },
        return: null
      }
    });

    const catalog = inspectCursorHelpNativeModelCatalog(document);

    expect(catalog.selectedModel).toBe("Claude Sonnet 4.6");
    expect(catalog.availableModels).toEqual([
      "Claude Sonnet 4.6",
      "Gemini 2.5 Pro"
    ]);
  });
});
