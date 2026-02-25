import "./test-setup";

import { describe, expect, it } from "vitest";
import { ToolContractRegistry } from "../tool-contract-registry";

const CANONICAL_BROWSER_TOOLS = [
  "get_all_tabs",
  "get_current_tab",
  "create_new_tab",
  "get_tab_info",
  "close_tab",
  "ungroup_tabs",
  "search_elements",
  "click",
  "fill_element_by_uid",
  "select_option_by_uid",
  "hover_element_by_uid",
  "get_editor_value",
  "press_key",
  "scroll_page",
  "navigate_tab",
  "fill_form",
  "browser_verify",
  "computer",
  "get_page_metadata",
  "scroll_to_element",
  "highlight_element",
  "highlight_text_inline",
  "capture_screenshot",
  "capture_tab_screenshot",
  "capture_screenshot_with_highlight",
  "download_image",
  "download_chat_images",
  "list_interventions",
  "get_intervention_info",
  "request_intervention",
  "cancel_intervention",
  "load_skill",
  "execute_skill_script",
  "read_skill_reference",
  "get_skill_asset",
  "list_skills",
  "get_skill_info"
] as const;

describe("tool-contract-registry", () => {
  it("exports canonical tool surface without alias entries", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();
    const names = defs.map((item) => item.function.name);

    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");

    for (const toolName of CANONICAL_BROWSER_TOOLS) {
      expect(names).toContain(toolName);
    }

    expect(new Set(names).size).toBe(names.length);
    expect(registry.resolve("bash.run")).toBeNull();
  });

  it("ensures every contract has description and JSON-schema object parameters", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();

    for (const def of defs) {
      expect(String(def.function.description || "").trim().length).toBeGreaterThan(0);
      expect(def.function.parameters && typeof def.function.parameters === "object").toBe(true);
      expect((def.function.parameters as Record<string, unknown>).type).toBe("object");
    }
  });

  it("enforces target anyOf schema for element-targeting tools", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();

    const targetTools = [
      "click",
      "fill_element_by_uid",
      "select_option_by_uid",
      "hover_element_by_uid",
      "get_editor_value",
      "scroll_to_element"
    ];

    for (const name of targetTools) {
      const params = (defs.find((item) => item.function.name === name)?.function.parameters || {}) as Record<string, unknown>;
      const anyOf = params.anyOf as unknown[];
      expect(Array.isArray(anyOf)).toBe(true);
      expect(anyOf.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("validates required fields for high-risk browser actions", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();

    const requiredByTool: Record<string, string[]> = {
      create_new_tab: ["url"],
      get_tab_info: ["tabId"],
      fill_element_by_uid: ["value"],
      select_option_by_uid: ["value"],
      press_key: ["key"],
      navigate_tab: ["url"],
      fill_form: ["elements"],
      computer: ["action"],
      download_image: ["imageData"],
      download_chat_images: ["messages"],
      get_intervention_info: ["type"],
      request_intervention: ["type"],
      load_skill: ["name"],
      execute_skill_script: ["skillName", "scriptPath"],
      read_skill_reference: ["skillName", "refPath"],
      get_skill_asset: ["skillName", "assetPath"],
      get_skill_info: ["skillName"]
    };

    for (const [toolName, requiredFields] of Object.entries(requiredByTool)) {
      const params = (defs.find((item) => item.function.name === toolName)?.function.parameters || {}) as Record<string, unknown>;
      const required = ((params.required as string[]) || []).slice().sort();
      expect(required).toEqual(requiredFields.slice().sort());
    }
  });

  it("supports override register/unregister for existing contract", () => {
    const registry = new ToolContractRegistry();
    const original = registry
      .listLlmToolDefinitions()
      .find((item) => item.function.name === "bash")?.function.description;
    expect(String(original || "")).toContain("Execute a shell command");

    registry.register(
      {
        name: "bash",
        description: "Run command through provider-registry.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" }
          },
          required: ["command"]
        }
      },
      { replace: true }
    );

    const overridden = registry
      .listLlmToolDefinitions()
      .find((item) => item.function.name === "bash")?.function.description;
    expect(overridden).toBe("Run command through provider-registry.");
    expect(registry.listContracts().find((item) => item.name === "bash")?.source).toBe("override");

    expect(registry.unregister("bash")).toBe(true);
    const restored = registry
      .listLlmToolDefinitions()
      .find((item) => item.function.name === "bash")?.function.description;
    expect(String(restored || "")).toContain("Execute a shell command");
    expect(registry.listContracts().find((item) => item.name === "bash")?.source).toBe("builtin");
  });
});
