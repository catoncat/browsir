import "./test-setup";

import { describe, expect, it } from "vitest";
import { ToolContractRegistry } from "../tool-contract-registry";

describe("tool-contract-registry", () => {
  it("provides default llm tool definitions", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();
    const names = defs.map((item) => item.function.name);

    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("search_elements");
    expect(names).toContain("click");
    expect(names).toContain("fill_element_by_uid");
    expect(names).toContain("select_option_by_uid");
    expect(names).toContain("press_key");
    expect(names).toContain("scroll_page");
    expect(names).toContain("navigate_tab");
    expect(names).toContain("fill_form");
    expect(names).toContain("browser_verify");
    expect(names).toContain("get_all_tabs");
    expect(names).toContain("get_current_tab");
    expect(names).toContain("create_new_tab");
  });

  it("enforces uid/ref/backendNodeId targeting schema for element actions", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();
    const clickDef = defs.find((item) => item.function.name === "click")?.function;
    const fillDef = defs.find((item) => item.function.name === "fill_element_by_uid")?.function;
    const selectDef = defs.find((item) => item.function.name === "select_option_by_uid")?.function;

    const clickParams = (clickDef?.parameters as Record<string, unknown>) || {};
    const fillParams = (fillDef?.parameters as Record<string, unknown>) || {};
    const selectParams = (selectDef?.parameters as Record<string, unknown>) || {};

    expect(Array.isArray(clickParams.anyOf)).toBe(true);
    expect(Array.isArray(fillParams.anyOf)).toBe(true);
    expect(Array.isArray(selectParams.anyOf)).toBe(true);
  });

  it("exposes runtime hint schema for fs/process tools", () => {
    const registry = new ToolContractRegistry();
    const defs = registry.listLlmToolDefinitions();

    const readDef = defs.find((item) => item.function.name === "read_file")?.function;
    const writeDef = defs.find((item) => item.function.name === "write_file")?.function;
    const editDef = defs.find((item) => item.function.name === "edit_file")?.function;
    const bashDef = defs.find((item) => item.function.name === "bash")?.function;

    const readRuntime = ((readDef?.parameters as Record<string, unknown>)?.properties as Record<string, unknown>)?.runtime as
      | Record<string, unknown>
      | undefined;
    const writeRuntime = ((writeDef?.parameters as Record<string, unknown>)?.properties as Record<string, unknown>)?.runtime as
      | Record<string, unknown>
      | undefined;
    const editRuntime = ((editDef?.parameters as Record<string, unknown>)?.properties as Record<string, unknown>)?.runtime as
      | Record<string, unknown>
      | undefined;
    const bashRuntime = ((bashDef?.parameters as Record<string, unknown>)?.properties as Record<string, unknown>)?.runtime as
      | Record<string, unknown>
      | undefined;

    expect(readRuntime?.enum).toEqual(["browser", "local"]);
    expect(writeRuntime?.enum).toEqual(["browser", "local"]);
    expect(editRuntime?.enum).toEqual(["browser", "local"]);
    expect(bashRuntime?.enum).toEqual(["browser", "local"]);
  });

  it("supports override register/unregister for existing contract", () => {
    const registry = new ToolContractRegistry();
    const original = registry
      .listLlmToolDefinitions()
      .find((item) => item.function.name === "bash")?.function.description;
    expect(String(original || "")).toContain("Execute a shell command via bash.exec.");

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
    expect(String(restored || "")).toContain("Execute a shell command via bash.exec.");
    expect(registry.listContracts().find((item) => item.name === "bash")?.source).toBe("builtin");
  });

  it("supports alias resolve and alias export in llm tool list", () => {
    const registry = new ToolContractRegistry();
    registry.register(
      {
        name: "command.run",
        aliases: ["bash.run"],
        description: "Execute command by command id",
        parameters: {
          type: "object",
          properties: {
            commandId: { type: "string" }
          },
          required: ["commandId"]
        }
      },
      { replace: true }
    );

    expect(registry.resolve("bash.run")?.name).toBe("command.run");
    const defs = registry.listLlmToolDefinitions({ includeAliases: true });
    expect(defs.some((item) => item.function.name === "command.run")).toBe(true);
    expect(defs.some((item) => item.function.name === "bash.run")).toBe(true);
  });
});
