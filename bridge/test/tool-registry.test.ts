import { describe, expect, test } from "bun:test";
import { isSupportedToolName, listToolContracts, resolveToolName } from "../src/tool-registry";

describe("tool-registry", () => {
  test("resolves builtin tool aliases", () => {
    expect(resolveToolName("read_file")).toBe("read");
    expect(resolveToolName("write_file")).toBe("write");
    expect(resolveToolName("edit_file")).toBe("edit");
    expect(resolveToolName("command.run")).toBe("bash");
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
});

