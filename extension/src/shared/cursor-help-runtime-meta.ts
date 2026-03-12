export const CURSOR_HELP_RUNTIME_VERSION = "cursor-help-runtime-2026-03-12-r1";
export const CURSOR_HELP_REWRITE_STRATEGY = "system_message+user_prefix";

export const CURSOR_HELP_PAGE_RUNTIME_VERSION_ATTR = "data-bbl-cursor-help-runtime-version";
export const CURSOR_HELP_PAGE_REWRITE_STRATEGY_ATTR = "data-bbl-cursor-help-rewrite-strategy";
export const CURSOR_HELP_CONTENT_RUNTIME_VERSION_ATTR = "data-bbl-cursor-help-content-version";

export function isCursorHelpRuntimeMismatch(runtimeVersion: string, expectedVersion = CURSOR_HELP_RUNTIME_VERSION): boolean {
  const actual = String(runtimeVersion || "").trim();
  const expected = String(expectedVersion || "").trim();
  if (!actual || !expected) return true;
  return actual !== expected;
}
