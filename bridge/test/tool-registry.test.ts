import { describe, expect, test } from "bun:test";
import {
  isSupportedToolName,
  listToolContracts,
  registerToolContract,
  resolveToolName,
  unregisterToolContract
} from "../src/tool-registry";

describe("tool-registry", () => {
  test("resolves builtin canonical tool names", () => {
    expect(resolveToolName("read")).toBe("read");
    expect(resolveToolName("write")).toBe("write");
    expect(resolveToolName("edit")).toBe("edit");
    expect(resolveToolName("bash")).toBe("bash");
  });

  test("rejects legacy alias names", () => {
    expect(resolveToolName("read_file")).toBeNull();
    expect(isSupportedToolName("read_file")).toBe(false);
  });

  test("rejects unknown tool name", () => {
    expect(resolveToolName("unknown.tool")).toBeNull();
    expect(isSupportedToolName("unknown.tool")).toBe(false);
  });

  test("lists builtin contracts", () => {
    const contracts = listToolContracts();
    const names = contracts.map((item) => item.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("edit");
    expect(names).toContain("bash");
  });

  test("supports dynamic register/unregister for custom contract", () => {
    registerToolContract({
      name: "memory.read",
    });

    expect(resolveToolName("memory.read")).toBe("memory.read");
    const listed = listToolContracts().find((item) => item.name === "memory.read");
    expect(listed?.source).toBe("override");

    expect(unregisterToolContract("memory.read")).toBe(true);
    expect(resolveToolName("memory.read")).toBeNull();
  });
});
