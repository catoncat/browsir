import type { ExtensionAPI } from "../../extension-api";

export default function registerPlugin(pi: ExtensionAPI): void {
  pi.on("tool.after_result", (event) => {
    const previous = (event.result || {}) as Record<string, unknown>;
    return {
      action: "patch",
      patch: {
        result: {
          ...previous,
          source: "extension-module"
        }
      }
    };
  });
}
