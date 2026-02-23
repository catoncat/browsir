import { BrainOrchestrator, initSessionIndex, registerRuntimeRouter, resetSessionStore } from "../sw/kernel";

const LEGACY_STORAGE_KEY = "chatState.v2";

const orchestrator = new BrainOrchestrator();
registerRuntimeRouter(orchestrator);

function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // sidepanel may be closed
  });
}

async function hasLegacyState(): Promise<boolean> {
  const bag = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
  return Boolean(bag[LEGACY_STORAGE_KEY]);
}

async function bootstrapSessionStore(): Promise<void> {
  const legacyExists = await hasLegacyState();

  if (legacyExists) {
    const result = await resetSessionStore({
      includeTrace: true,
      preserveArchive: true,
      archiveLegacyBeforeReset: true
    });
    broadcast({
      type: "brain.bootstrap",
      mode: "legacy-reset",
      result
    });
    return;
  }

  await initSessionIndex();
}

orchestrator.events.subscribe((event) => {
  broadcast({ type: "brain.event", event });
});

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapSessionStore();
});

chrome.runtime.onStartup?.addListener(() => {
  void bootstrapSessionStore();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.sidePanel.open({ tabId: tab.id });
});
