import { onBeforeUnmount, onMounted, ref } from "vue";

function resolveDocumentThemeDark(): boolean {
  if (typeof document === "undefined") return false;
  const nodes = [document.documentElement, document.body].filter(Boolean) as HTMLElement[];
  for (const node of nodes) {
    const themeAttr = String(node.getAttribute("data-theme") || "").trim().toLowerCase();
    if (themeAttr === "dark") return true;
    if (node.classList.contains("theme-dark")) return true;
  }
  return false;
}

function resolveMediaDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function usePanelDarkMode() {
  const isDark = ref(resolveDocumentThemeDark() || resolveMediaDark());

  let mediaQuery: MediaQueryList | null = null;
  const observers: MutationObserver[] = [];

  const sync = () => {
    isDark.value = resolveDocumentThemeDark() || resolveMediaDark();
  };

  const handleMediaChange = () => {
    sync();
  };

  onMounted(() => {
    sync();
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleMediaChange);
      } else {
        mediaQuery.addListener(handleMediaChange);
      }
    }

    if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
      const targets = [document.documentElement, document.body].filter(Boolean) as HTMLElement[];
      for (const target of targets) {
        const observer = new MutationObserver(sync);
        observer.observe(target, {
          attributes: true,
          attributeFilter: ["class", "data-theme"]
        });
        observers.push(observer);
      }
    }
  });

  onBeforeUnmount(() => {
    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
    }
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
  });

  return isDark;
}
