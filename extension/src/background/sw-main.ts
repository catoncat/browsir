import { BrainOrchestrator, initSessionIndex, registerRuntimeRouter } from "../sw/kernel";

const orchestrator = new BrainOrchestrator();
registerRuntimeRouter(orchestrator);

function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // sidepanel may be closed
  });
}

async function bootstrapSessionStore(): Promise<void> {
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
