import "./test-setup";

import { describe, expect, it } from "vitest";
import { createRuntimeInfraHandler } from "../runtime-infra.browser";

describe("runtime-infra contenteditable backend action", () => {
  it("builds backendNode fill script with insertText + fallback semantics", async () => {
    let functionDeclaration = "";

    (chrome as unknown as { debugger: unknown }).debugger = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj-42" } };
        }
        if (method === "Runtime.callFunctionOn") {
          functionDeclaration = String(params.functionDeclaration || "");
          return {
            result: {
              value: {
                ok: true,
                via: "backend-node-contenteditable-inserttext",
                typed: 5,
                mode: "fill",
                url: "https://example.com/page",
                title: "Example"
              }
            }
          };
        }
        return {};
      },
      onEvent: {
        addListener: () => {}
      },
      onDetach: {
        addListener: () => {}
      }
    };

    const infra = createRuntimeInfraHandler();
    const lease = await infra.handleMessage({
      type: "lease.acquire",
      tabId: 7,
      owner: "tester",
      ttlMs: 5_000
    });
    expect(lease?.ok).toBe(true);

    const action = await infra.handleMessage({
      type: "cdp.action",
      tabId: 7,
      owner: "tester",
      action: {
        kind: "fill",
        backendNodeId: 42,
        value: "hello"
      }
    });

    expect(action?.ok).toBe(true);
    expect(functionDeclaration).toContain('document.execCommand("insertText", false, text)');
    expect(functionDeclaration).toContain("backend-node-contenteditable-inserttext");
    expect(functionDeclaration).toContain("backend-node-contenteditable-fallback");
  });
});
