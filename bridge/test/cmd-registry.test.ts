import { describe, expect, test } from "bun:test";
import { resolveCommand } from "../src/cmd-registry";

describe("resolveCommand", () => {
  test("allows bash.exec in god mode", () => {
    const out = resolveCommand("bash.exec", ["echo hi"], {
      strictMode: false,
      enableBashExec: true,
    });
    expect(out.argv).toEqual(["bash", "-lc", "echo hi"]);
    expect(out.risk).toBe("high");
  });

  test("allows bash.exec in strict mode too", () => {
    const out = resolveCommand("bash.exec", ["echo hi"], {
      strictMode: true,
      enableBashExec: true,
    });
    expect(out.argv).toEqual(["bash", "-lc", "echo hi"]);
  });

  test("can disable bash.exec explicitly", () => {
    expect(() =>
      resolveCommand("bash.exec", ["echo hi"], {
        strictMode: false,
        enableBashExec: false,
      }),
    ).toThrow();
  });

  test("allows low-risk command in strict mode", () => {
    const out = resolveCommand("git.status", [], {
      strictMode: true,
      enableBashExec: false,
    });
    expect(out.argv).toEqual(["git", "status", "--short", "--branch"]);
    expect(out.risk).toBe("low");
  });
});
