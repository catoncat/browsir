import { describe, expect, it } from "vitest";
import {
  getProviderToolSchemaDialect,
  providerUsesOpenAiCompatibleToolSchema,
} from "../../../shared/llm-provider-config";

describe("llm-provider-config shared helpers", () => {
  it("treats non-cursor providers as openai-compatible tool schema routes", () => {
    expect(getProviderToolSchemaDialect("openai_compatible")).toBe(
      "openai_compatible",
    );
    expect(getProviderToolSchemaDialect("rs")).toBe("openai_compatible");
    expect(providerUsesOpenAiCompatibleToolSchema("openrouter")).toBe(true);
  });

  it("keeps cursor_help_web on hosted chat tool schema dialect", () => {
    expect(getProviderToolSchemaDialect("cursor_help_web")).toBe("hosted_chat");
    expect(providerUsesOpenAiCompatibleToolSchema("cursor_help_web")).toBe(
      false,
    );
  });
});
