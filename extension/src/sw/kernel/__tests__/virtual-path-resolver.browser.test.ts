import "./test-setup";

import { describe, expect, it } from "vitest";
import {
  normalizeRelativePath,
  resolveVirtualPath,
  parseVirtualUri,
} from "../browser-unix-runtime/virtual-path-resolver";

describe("normalizeRelativePath", () => {
  it("normalizes simple paths", () => {
    expect(normalizeRelativePath("a/b/c")).toBe("a/b/c");
  });

  it("strips leading/trailing slashes and dots", () => {
    expect(normalizeRelativePath("./a/./b")).toBe("a/b");
  });

  it("resolves internal .. segments", () => {
    expect(normalizeRelativePath("a/b/../c")).toBe("a/c");
  });

  it("throws on path traversal beyond root", () => {
    expect(() => normalizeRelativePath("../secret")).toThrow();
    expect(() => normalizeRelativePath("../../etc/passwd")).toThrow();
    expect(() => normalizeRelativePath("a/../../b")).toThrow();
  });

  it("handles empty path", () => {
    expect(normalizeRelativePath("")).toBe("");
  });
});

describe("resolveVirtualPath", () => {
  const SESSION_ID = "test-session";

  it("resolves session-scoped mem:// paths", () => {
    const result = resolveVirtualPath("mem://hello.txt", SESSION_ID);
    expect(result.relativePath).toBe("hello.txt");
    expect(result.uri).toBe("mem://hello.txt");
    expect(result.namespace.scope).toBe("session");
  });

  it("resolves skills namespace", () => {
    const result = resolveVirtualPath("mem://skills/my-skill/code.js", SESSION_ID);
    expect(result.namespace.scope).toBe("global");
    expect(result.relativePath).toBe("my-skill/code.js");
  });

  it("resolves builtin skills namespace", () => {
    const result = resolveVirtualPath(
      "mem://builtin-skills/skill-authoring/SKILL.md",
      SESSION_ID
    );
    expect(result.namespace.scope).toBe("global");
    expect(result.relativePath).toBe("skill-authoring/SKILL.md");
  });

  it("resolves plugins namespace", () => {
    const result = resolveVirtualPath("mem://plugins/my-plugin/init.js", SESSION_ID);
    expect(result.namespace.scope).toBe("global");
    expect(result.relativePath).toBe("my-plugin/init.js");
  });

  it("resolves __bbl system namespace", () => {
    const result = resolveVirtualPath("mem://__bbl/state.json", SESSION_ID);
    expect(result.relativePath).toBe("state.json");
  });

  it("rejects path traversal via mem://../../../etc/passwd", () => {
    expect(() => resolveVirtualPath("mem://../../../etc/passwd", SESSION_ID)).toThrow();
  });

  it("rejects path traversal via mem://skills/../../../etc/passwd", () => {
    expect(() => resolveVirtualPath("mem://skills/../../../etc/passwd", SESSION_ID)).toThrow();
  });

  it("rejects path traversal via /mem/../secret", () => {
    expect(() => resolveVirtualPath("/mem/../secret", SESSION_ID)).toThrow();
  });

  it("handles mem:// with empty path", () => {
    const result = resolveVirtualPath("mem://", SESSION_ID);
    expect(result.relativePath).toBe("");
  });
});

describe("parseVirtualUri", () => {
  it("parses mem:// scheme", () => {
    const result = parseVirtualUri("mem://hello.txt");
    expect(result.scheme).toBe("mem");
    expect(result.path).toBe("hello.txt");
  });

  it("parses /mem/ mount path", () => {
    const result = parseVirtualUri("/mem/hello.txt");
    expect(result.scheme).toBe("mem");
    expect(result.path).toBe("hello.txt");
  });

  it("normalizes backslashes", () => {
    const result = parseVirtualUri("mem://a\\b\\c");
    expect(result.path).toBe("a/b/c");
  });
});
