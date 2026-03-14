import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelUiPluginRuntime } from "../ui-plugin-runtime";

const widgetModuleUrl = new URL("./fixtures/ui-widget-plugin.ts", import.meta.url).href;
const missionHudDogWidgetModuleUrl = new URL("../../../../plugins/example-mission-hud-dog/ui.js", import.meta.url).href;

class FakeElement {
  tagName: string;
  dataset: Record<string, string> = {};
  textContent = "";
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  private attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    const match = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
    if (!match) return null;
    const [, attr, expected] = match;
    const queue = [...this.children];
    while (queue.length > 0) {
      const current = queue.shift() || null;
      if (!current) continue;
      if (attr.startsWith("data-")) {
        const key = attr
          .slice(5)
          .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
        if (String(current.dataset[key] || "") === expected) return current;
      }
      if (current.getAttribute(attr) === expected) return current;
      queue.push(...current.children);
    }
    return null;
  }
}

function createFakeDocument() {
  const body = new FakeElement("body");
  const head = new FakeElement("head");
  return {
    body,
    head,
    createElement(tagName: string) {
      return new FakeElement(tagName);
    },
    getElementById(_id: string) {
      return null;
    }
  };
}

function createChromeRuntimeMock() {
  const sendMessage = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      hookResult: {
        action: "patch",
        patch: {
          message: "发送成功!"
        }
      }
    }
  });
  const listeners = new Set<(message: unknown) => void>();
  return {
    sendMessage,
    onMessage: {
      addListener(listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      removeListener(listener: (message: unknown) => void) {
        listeners.delete(listener);
      }
    },
    emitMessage(message: unknown) {
      for (const listener of listeners) {
        listener(message);
      }
    }
  };
}

describe("panel ui plugin runtime remote mem hooks", () => {
  let chromeRuntime: ReturnType<typeof createChromeRuntimeMock>;

  beforeEach(() => {
    chromeRuntime = createChromeRuntimeMock();
    (globalThis as Record<string, unknown>).chrome = {
      runtime: chromeRuntime
    };
    (globalThis as Record<string, unknown>).document = createFakeDocument();
  });

  it("routes mem:// descriptor hook through brain.plugin.ui_hook.run", async () => {
    const runtime = createPanelUiPluginRuntime({ defaultTimeoutMs: 120 });
    await runtime.hydrate([
      {
        pluginId: "plugin.test.ui.mem",
        moduleUrl: "mem://plugins/plugin.test.ui.mem/ui.js",
        exportName: "default",
        enabled: true,
        sessionId: "plugin-studio"
      }
    ]);

    const result = await runtime.runHook("ui.notice.before_show", {
      type: "success",
      message: "发送成功"
    });

    expect(result.blocked).toBe(false);
    expect(result.value.message).toBe("发送成功!");

    const chromeLike = (globalThis as Record<string, unknown>).chrome as {
      runtime?: { sendMessage?: ReturnType<typeof vi.fn> };
    };
    const sendMessage = chromeLike.runtime?.sendMessage;
    expect(sendMessage).toBeTypeOf("function");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "brain.plugin.ui_hook.run",
        pluginId: "plugin.test.ui.mem",
        hook: "ui.notice.before_show",
        sessionId: "plugin-studio"
      })
    );
  });

  it("mounts and cleans widget plugins in host slots", async () => {
    const runtime = createPanelUiPluginRuntime({
      defaultTimeoutMs: 120,
      getActiveSessionId: () => "session-active"
    });
    const host = document.createElement("div") as unknown as FakeElement;
    document.body.appendChild(host as unknown as FakeElement);

    await runtime.attachHostSlot("chat.scene.overlay", host);
    await runtime.hydrate([
      {
        pluginId: "plugin.test.ui.widget",
        moduleUrl: widgetModuleUrl,
        exportName: "default",
        enabled: true
      }
    ]);

    const mounted = host.querySelector(
      '[data-plugin-widget-instance="plugin.test.ui.widget:widget.test"]'
    ) as unknown as FakeElement | null;
    expect(mounted).toBeTruthy();
    expect(mounted?.textContent).toBe("active=session-active");
    expect(mounted?.getAttribute("data-mounted")).toBe("true");

    await runtime.disable("plugin.test.ui.widget");
    expect(
      host.querySelector('[data-plugin-widget-instance="plugin.test.ui.widget:widget.test"]')
    ).toBeNull();

    await runtime.dispose();
    host.remove();
  });

  it("captures load failures for broken file-backed ui plugins", async () => {
    const runtime = createPanelUiPluginRuntime({ defaultTimeoutMs: 120 });

    await runtime.hydrate([
      {
        pluginId: "plugin.test.ui.broken",
        moduleUrl: "data:text/javascript,export default 42",
        exportName: "default",
        enabled: true
      }
    ]);

    expect(runtime.listLoadFailures()).toEqual([
      expect.objectContaining({
        pluginId: "plugin.test.ui.broken",
        moduleUrl: "data:text/javascript,export default 42",
        exportName: "default"
      })
    ]);
  });

  it("allows mission-hud-dog messages before active session hydrates and hides on session switch", async () => {
    let activeSessionId = "";
    const runtime = createPanelUiPluginRuntime({
      defaultTimeoutMs: 120,
      getActiveSessionId: () => activeSessionId || undefined
    });
    const host = document.createElement("div") as unknown as FakeElement;
    document.body.appendChild(host as unknown as FakeElement);

    await runtime.attachHostSlot("chat.scene.overlay", host);
    await runtime.hydrate([
      {
        pluginId: "plugin.example.ui.mission-hud.dog",
        moduleUrl: missionHudDogWidgetModuleUrl,
        exportName: "default",
        enabled: true
      }
    ]);

    const mounted = host.querySelector(
      '[data-plugin-widget-instance="plugin.example.ui.mission-hud.dog:mission-hud-dog"]'
    ) as unknown as FakeElement | null;
    expect(mounted).toBeTruthy();

    const root = mounted?.children[0] || null;
    expect(root?.dataset.visible).toBe("false");

    chromeRuntime.emitMessage({
      type: "bbloop.ui.mascot",
      payload: {
        phase: "thinking",
        message: "汪！我先闻闻线索，马上开始。",
        sessionId: "session-before-hydrate"
      }
    });

    expect(root?.dataset.visible).toBe("true");

    activeSessionId = "session-next";
    await runtime.notifyActiveSessionChanged(activeSessionId, "session-before-hydrate");
    expect(root?.dataset.visible).toBe("false");

    await runtime.dispose();
    host.remove();
  });

  it("blocks mission-hud-dog messages from another active session", async () => {
    const runtime = createPanelUiPluginRuntime({
      defaultTimeoutMs: 120,
      getActiveSessionId: () => "session-active"
    });
    const host = document.createElement("div") as unknown as FakeElement;
    document.body.appendChild(host as unknown as FakeElement);

    await runtime.attachHostSlot("chat.scene.overlay", host);
    await runtime.hydrate([
      {
        pluginId: "plugin.example.ui.mission-hud.dog",
        moduleUrl: missionHudDogWidgetModuleUrl,
        exportName: "default",
        enabled: true
      }
    ]);

    const mounted = host.querySelector(
      '[data-plugin-widget-instance="plugin.example.ui.mission-hud.dog:mission-hud-dog"]'
    ) as unknown as FakeElement | null;
    const root = mounted?.children[0] || null;
    expect(root?.dataset.visible).toBe("false");

    chromeRuntime.emitMessage({
      type: "bbloop.ui.mascot",
      payload: {
        phase: "tool",
        message: "我去执行工具。",
        sessionId: "session-other"
      }
    });

    expect(root?.dataset.visible).toBe("false");

    await runtime.dispose();
    host.remove();
  });
});
