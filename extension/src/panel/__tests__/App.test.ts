// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

import { useRuntimeStore } from "../stores/runtime";
import { useChatStore } from "../stores/chat-store";

const sessionListPropsLog: Array<{ count: number; activeId: string }> = [];
const mountedApps: Array<() => void> = [];

vi.mock("../ChatView.vue", async () => {
  const { defineComponent, h, onMounted, ref } = await import("vue");
  return {
    default: defineComponent({
      name: "ChatViewStub",
      emits: ["update:active-view", "update:list-open", "create-session"],
      setup(_props, { emit, expose }) {
        const sessionListRenderState = ref({
          sessions: [
            {
              id: "session-1",
              title: "第一条会话",
              updatedAt: "2026-03-17T10:00:00.000Z",
            },
          ],
          activeId: "session-1",
        });
        const handleCreateSession = vi.fn();

        expose({
          handleCreateSession,
          sessionListRenderState,
        });

        onMounted(() => {
          emit("update:list-open", true);
        });

        return () => h("div", { "data-testid": "chat-view-stub" });
      },
    }),
  };
});

vi.mock("../components/SessionList.vue", async () => {
  const { defineComponent, h, watchEffect } = await import("vue");
  return {
    default: defineComponent({
      name: "SessionListStub",
      props: {
        sessions: {
          type: Array,
          default: () => [],
        },
        activeId: {
          type: String,
          default: "",
        },
        isOpen: {
          type: Boolean,
          default: false,
        },
        loading: {
          type: Boolean,
          default: false,
        },
      },
      setup(props) {
        watchEffect(() => {
          sessionListPropsLog.push({
            count: Array.isArray(props.sessions) ? props.sessions.length : 0,
            activeId: String(props.activeId || ""),
          });
        });

        return () =>
          h("div", {
            "data-testid": "session-list-stub",
            "data-count": String(
              Array.isArray(props.sessions) ? props.sessions.length : 0,
            ),
            "data-active-id": String(props.activeId || ""),
          });
      },
    }),
  };
});

vi.mock("../components/SettingsView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SettingsViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

vi.mock("../components/ProviderSettingsView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "ProviderSettingsViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

vi.mock("../components/McpSettingsView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "McpSettingsViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

vi.mock("../components/SkillsView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "SkillsViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

vi.mock("../components/PluginsView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "PluginsViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

vi.mock("../components/DebugView.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "DebugViewStub",
      setup() {
        return () => h("div");
      },
    }),
  };
});

function flushUi(): Promise<void> {
  return Promise.resolve().then(() => nextTick());
}

async function mountApp() {
  const pinia = createPinia();
  setActivePinia(pinia);

  const runtimeStore = useRuntimeStore();
  runtimeStore.loading = false;
  runtimeStore.bootstrap = vi.fn().mockResolvedValue(undefined);

  const chatStore = useChatStore();
  chatStore.loadConversation = vi.fn().mockResolvedValue(undefined);
  chatStore.deleteSession = vi.fn().mockResolvedValue(undefined);
  chatStore.updateSessionTitle = vi.fn().mockResolvedValue(undefined);

  const { default: App } = await import("../App.vue");
  const root = document.createElement("div");
  document.body.appendChild(root);

  const app = createApp(App);
  app.use(pinia);
  app.mount(root);
  await flushUi();
  await flushUi();

  const unmount = () => {
    app.unmount();
    root.remove();
  };
  mountedApps.push(unmount);

  return { root, unmount };
}

afterEach(() => {
  while (mountedApps.length > 0) {
    mountedApps.pop()?.();
  }
  sessionListPropsLog.length = 0;
  vi.restoreAllMocks();
});

describe("App", () => {
  it("passes ChatView exposed session list render state into SessionList", async () => {
    const view = await mountApp();
    const sessionList = view.root.querySelector(
      '[data-testid="session-list-stub"]',
    ) as HTMLDivElement | null;

    expect(sessionList).not.toBeNull();
    expect(sessionList?.dataset.count).toBe("1");
    expect(sessionList?.dataset.activeId).toBe("session-1");
    expect(
      sessionListPropsLog.some(
        (item) => item.count === 1 && item.activeId === "session-1",
      ),
    ).toBe(true);
  });
});
