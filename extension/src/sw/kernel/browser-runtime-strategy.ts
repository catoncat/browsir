export type BrowserRuntimeStrategy = "browser-first" | "host-first";

const BROWSER_UNIX_RUNTIME_HINTS = new Set(["sandbox", "browser_unix", "lifo"]);

export function normalizeBrowserRuntimeStrategy(
  raw: unknown,
  fallback: BrowserRuntimeStrategy = "host-first"
): BrowserRuntimeStrategy {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "browser-first") return "browser-first";
  if (value === "host-first") return "host-first";
  return fallback;
}

export function resolveBrowserRuntimeHint(
  runtimeHint: unknown,
  strategy: BrowserRuntimeStrategy
): "browser" | "sandbox" {
  const hint = String(runtimeHint || "").trim().toLowerCase();
  if (BROWSER_UNIX_RUNTIME_HINTS.has(hint)) return "sandbox";
  if (hint === "browser") return "browser";
  return strategy === "browser-first" ? "sandbox" : "browser";
}
