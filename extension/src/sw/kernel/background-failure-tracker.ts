/**
 * Background Failure Tracker
 *
 * Tracks consecutive background-mode failures per tab.
 * When failures exceed a threshold, attaches an upgrade hint
 * suggesting the user switch to focus mode.
 *
 * Does NOT auto-switch — preserves user control.
 */

const CONSECUTIVE_FAILURE_THRESHOLD = 3;

interface TabFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  lastSuccessAt: number;
}

const tabFailures = new Map<number, TabFailureState>();

function getState(tabId: number): TabFailureState {
  let state = tabFailures.get(tabId);
  if (!state) {
    state = { consecutiveFailures: 0, lastFailureAt: 0, lastSuccessAt: 0 };
    tabFailures.set(tabId, state);
  }
  return state;
}

/** Record a successful background-mode operation. Resets failure counter. */
export function recordBackgroundSuccess(tabId: number): void {
  const state = getState(tabId);
  state.consecutiveFailures = 0;
  state.lastSuccessAt = Date.now();
}

/** Record a failed background-mode operation. Increments failure counter. */
export function recordBackgroundFailure(tabId: number): void {
  const state = getState(tabId);
  state.consecutiveFailures++;
  state.lastFailureAt = Date.now();
}

/** Check whether the upgrade hint should be attached. */
export function shouldSuggestUpgrade(tabId: number): boolean {
  const state = tabFailures.get(tabId);
  if (!state) return false;
  return state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD;
}

/** Get the current consecutive failure count for a tab. */
export function getConsecutiveFailures(tabId: number): number {
  return tabFailures.get(tabId)?.consecutiveFailures ?? 0;
}

/** Build the upgrade hint object to attach to tool responses. */
export function buildUpgradeHint(tabId: number): Record<string, unknown> | null {
  if (!shouldSuggestUpgrade(tabId)) return null;
  const state = tabFailures.get(tabId)!;
  return {
    upgrade_suggested: true,
    reason: "consecutive_background_failures",
    consecutive_failures: state.consecutiveFailures,
    threshold: CONSECUTIVE_FAILURE_THRESHOLD,
    recommendation: "Switch to focus mode for full CDP capabilities. Use the mode toggle in the chat header.",
  };
}

/** Clear tracking state for a tab (e.g. when tab is closed). */
export function clearTabFailureState(tabId: number): void {
  tabFailures.delete(tabId);
}

/** Reset all tracking state. Mainly for testing. */
export function resetAllFailureState(): void {
  tabFailures.clear();
}
