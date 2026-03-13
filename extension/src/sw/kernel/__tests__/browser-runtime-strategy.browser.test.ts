import "./test-setup";

import { describe, expect, it } from "vitest";
import { normalizeBrowserRuntimeStrategy, resolveBrowserRuntimeHint } from "../browser-runtime-strategy";

describe("browser-runtime-strategy", () => {
  it("normalizes strategy with stable fallback", () => {
    expect(normalizeBrowserRuntimeStrategy("browser-first")).toBe("browser-first");
    expect(normalizeBrowserRuntimeStrategy("host-first")).toBe("host-first");
    expect(normalizeBrowserRuntimeStrategy("invalid", "browser-first")).toBe("browser-first");
    expect(normalizeBrowserRuntimeStrategy(undefined)).toBe("host-first");
  });

  it("resolves runtime hint with strategy default", () => {
    expect(resolveBrowserRuntimeHint("sandbox", "host-first")).toBe("sandbox");
    expect(resolveBrowserRuntimeHint("browser_unix", "host-first")).toBe("sandbox");
    expect(resolveBrowserRuntimeHint("lifo", "host-first")).toBe("sandbox");
    expect(resolveBrowserRuntimeHint("browser", "browser-first")).toBe("browser");
    expect(resolveBrowserRuntimeHint(undefined, "host-first")).toBe("browser");
    expect(resolveBrowserRuntimeHint(undefined, "browser-first")).toBe("sandbox");
  });
});
