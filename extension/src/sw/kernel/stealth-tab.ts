/**
 * Stealth Tab Manager
 *
 * Creates tabs in a dedicated minimized window, making them invisible
 * to the user while retaining full content script + CDP capabilities.
 *
 * Used by background automation mode to avoid polluting the user's
 * visible tab bar with automation tabs.
 */

let stealthWindowId: number | null = null;
const stealthTabs = new Set<number>();

/**
 * Ensure the stealth (minimized) window exists.
 * Creates one if it doesn't exist or was closed.
 */
async function ensureStealthWindow(): Promise<number> {
  if (stealthWindowId !== null) {
    try {
      const win = await chrome.windows.get(stealthWindowId);
      if (win?.id) return win.id;
    } catch {
      // Window was closed externally
      stealthWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    type: "popup",
    state: "minimized",
    focused: false,
    width: 800,
    height: 600,
  });
  if (!win?.id) {
    throw new Error("Failed to create stealth window");
  }
  stealthWindowId = win.id;

  // The new window comes with a blank tab — close it
  const blankTabs = win.tabs ?? [];
  for (const t of blankTabs) {
    if (t.id) {
      await chrome.tabs.remove(t.id).catch(() => {});
    }
  }

  return stealthWindowId;
}

/**
 * Create a new tab in the stealth window.
 * Returns the Chrome Tab object.
 */
export async function createStealthTab(
  url: string,
): Promise<chrome.tabs.Tab> {
  const windowId = await ensureStealthWindow();
  const tab = await chrome.tabs.create({
    url,
    windowId,
    active: false,
  });
  if (tab.id) {
    stealthTabs.add(tab.id);
  }
  return tab;
}

/** Check whether a tab lives in the stealth window. */
export function isStealthTab(tabId: number): boolean {
  return stealthTabs.has(tabId);
}

/** Get the current stealth window ID (if any). */
export function getStealthWindowId(): number | null {
  return stealthWindowId;
}

/** Get the count of active stealth tabs. */
export function getStealthTabCount(): number {
  return stealthTabs.size;
}

/**
 * Close a stealth tab. If the stealth window has no more tabs,
 * the window is closed automatically.
 */
export async function closeStealthTab(tabId: number): Promise<void> {
  if (!stealthTabs.has(tabId)) return;
  stealthTabs.delete(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
  if (stealthTabs.size === 0 && stealthWindowId !== null) {
    await closeStealthWindow();
  }
}

/** Close the stealth window and all its tabs. */
export async function closeStealthWindow(): Promise<void> {
  if (stealthWindowId === null) return;
  const wid = stealthWindowId;
  stealthWindowId = null;
  stealthTabs.clear();
  await chrome.windows.remove(wid).catch(() => {});
}

/**
 * Handle tab removal events — call from the global `chrome.tabs.onRemoved` listener.
 * Cleans up tracking state when stealth tabs are closed externally.
 */
export function handleTabRemoved(tabId: number): void {
  stealthTabs.delete(tabId);
  // Auto-close stealth window if empty
  if (stealthTabs.size === 0 && stealthWindowId !== null) {
    closeStealthWindow().catch(() => {});
  }
}

/** Reset all state. For testing. */
export function resetStealthState(): void {
  stealthWindowId = null;
  stealthTabs.clear();
}
