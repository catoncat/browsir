import { ref, type Ref, type ComputedRef } from "vue";
import { publishDebugLinkToBridge } from "../utils/debug-link";

interface RuntimeEvent {
  source: string;
  ts: string | number;
  type: string;
  preview: string;
  sessionId?: string;
}

export interface UseConversationExportOptions {
  activeSessionId: Ref<string | undefined>;
  activeSessionTitle: ComputedRef<string>;
  messages: Ref<Array<{ role?: string; content?: string }>>;
  config: Ref<{ bridgeUrl: string; bridgeToken: string }>;
  recentRuntimeEvents: Ref<RuntimeEvent[]>;
  showActionNoticeWithPlugins: (notice: {
    type: string;
    message: string;
    source: string;
  }) => Promise<void>;
  setErrorMessage: (err: unknown, fallback: string) => void;
}

export function useConversationExport(options: UseConversationExportOptions) {
  const {
    activeSessionId,
    activeSessionTitle,
    messages,
    config,
    recentRuntimeEvents,
    showActionNoticeWithPlugins,
    setErrorMessage,
  } = options;

  const showExportMenu = ref(false);
  const publishingDebugLink = ref(false);

  function generateMarkdown(): string {
    const title = activeSessionTitle.value;
    let md = `# ${title}\n\n`;

    messages.value.forEach((msg) => {
      if (msg.role === "user") {
        md += `**User**: ${msg.content}\n\n`;
      } else if (msg.role === "assistant") {
        const content = String(msg.content || "").trim();
        if (content) {
          md += `**Assistant**: ${content}\n\n`;
        }
      }
    });

    return md;
  }

  async function handleCopyMarkdown() {
    const md = generateMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      await showActionNoticeWithPlugins({
        type: "success",
        message: "已复制到剪贴板",
        source: "panel.copy_markdown",
      });
    } catch (err) {
      setErrorMessage(err, "复制失败");
    }
    showExportMenu.value = false;
  }

  async function handleCopyDebugLink() {
    if (publishingDebugLink.value) return;
    publishingDebugLink.value = true;
    try {
      const sessionId = String(activeSessionId.value || "").trim();
      const { downloadUrl } = await publishDebugLinkToBridge({
        bridgeUrl: config.value.bridgeUrl,
        bridgeToken: config.value.bridgeToken,
        title: activeSessionTitle.value,
        target: {
          kind: "session",
          sessionId: sessionId || undefined,
        },
        clientPayload: {
          recentEvents: recentRuntimeEvents.value.map((item) => ({
            source: item.source,
            ts: item.ts,
            type: item.type,
            preview: item.preview,
            sessionId: item.sessionId,
          })),
        },
      });
      await navigator.clipboard.writeText(downloadUrl);
      await showActionNoticeWithPlugins({
        type: "success",
        message: "调试链接已复制",
        source: "panel.publish_debug_link",
      });
    } catch (err) {
      setErrorMessage(err, "发布调试链接失败");
    } finally {
      publishingDebugLink.value = false;
    }
  }

  function handleExport(mode: "download" | "open") {
    const md = generateMarkdown();
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    if (mode === "download") {
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeSessionTitle.value.replace(/\s+/g, "_")}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      chrome.tabs.create({ url });
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    showExportMenu.value = false;
  }

  return {
    showExportMenu,
    publishingDebugLink,
    handleCopyMarkdown,
    handleCopyDebugLink,
    handleExport,
  };
}
