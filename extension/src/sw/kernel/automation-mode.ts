/**
 * Automation Mode — reads/writes the user-selected automation mode from chrome.storage.
 *
 * - "focus"      : full CDP path — debugger bar, window focus, screenshots, Input.dispatch
 * - "background" : DOM-only path — content-script snapshots, synthetic events, no debugger
 */

const STORAGE_KEY = "brain:automation_mode";

export type AutomationMode = "focus" | "background";

function isValidMode(value: unknown): value is AutomationMode {
  return value === "focus" || value === "background";
}

/** Read the current automation mode. Defaults to "focus" if unset or invalid. */
export async function getAutomationMode(): Promise<AutomationMode> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    return isValidMode(raw) ? raw : "focus";
  } catch {
    return "focus";
  }
}

/** Persist a new automation mode. */
export async function setAutomationMode(mode: AutomationMode): Promise<void> {
  if (!isValidMode(mode)) throw new Error(`Invalid automation mode: ${mode}`);
  await chrome.storage.local.set({ [STORAGE_KEY]: mode });
}

/**
 * Subscribe to automation-mode changes originating from other contexts
 * (e.g. side-panel toggle writes, other SW calls).
 * Returns an unsubscribe function.
 */
export function onAutomationModeChange(
  callback: (mode: AutomationMode) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local") return;
    const change = changes[STORAGE_KEY];
    if (!change) return;
    const newVal = change.newValue;
    if (isValidMode(newVal)) callback(newVal);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
