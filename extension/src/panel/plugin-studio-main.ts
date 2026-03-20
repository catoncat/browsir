import { createPinia } from "pinia";
import { createApp, defineComponent, h } from "vue";
import PluginStudioView from "./components/PluginStudioView.vue";
import "@incremark/theme/styles.css";
import "./styles.css";

function readTabId(tab: chrome.tabs.Tab | null): number {
  if (!tab) return 0;
  const raw = Number(tab.id);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

const Root = defineComponent({
  name: "PluginStudioRoot",
  setup() {
    const handleClose = async () => {
      try {
        const getCurrent = () =>
          new Promise<chrome.tabs.Tab | null>((resolve) => {
            if (!chrome?.tabs?.getCurrent) {
              resolve(null);
              return;
            }
            chrome.tabs.getCurrent((tab) => resolve(tab || null));
          });
        const currentTab = await getCurrent();
        const tabId = readTabId(currentTab);
        if (tabId > 0 && chrome?.tabs?.remove) {
          chrome.tabs.remove(tabId);
          return;
        }
      } catch {
        // ignore
      }
      window.close();
    };

    return () =>
      h(PluginStudioView, {
        onClose: handleClose
      });
  }
});

const app = createApp(Root);
app.use(createPinia());
app.mount("#app");
