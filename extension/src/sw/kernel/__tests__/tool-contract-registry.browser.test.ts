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
    expect(names).toContain("fill_form");
    expect(names).toContain("browser_verify");
    expect(names).toContain("get_all_tabs");
    expect(names).toContain("get_current_tab");
    expect(names).toContain("create_new_tab");
  });

  it("supports override register/unregister for existing contract", () => {
    const registry = new ToolContractRegistry();
    const original = registry
      .listLlmToolDefinitions()
      .find((item) => item.function.name === "bash")?.function.description;
    expect(original).toBe("Execute a shell command via bash.exec.");

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
    expect(restored).toBe("Execute a shell command via bash.exec.");
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
