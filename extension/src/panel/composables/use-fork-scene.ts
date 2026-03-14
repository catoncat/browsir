import { computed, nextTick, ref } from "vue";

const USER_FORK_MIN_VISIBLE_MS = 620;
const USER_FORK_SCENE_PREPARE_MS = 140;
const USER_FORK_SCENE_LEAVE_MS = 170;
const USER_FORK_SCENE_ENTER_MS = 240;
const FORK_SWITCH_HIGHLIGHT_MS = 1800;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function useForkScene(deps: {
  loadSession: (id: string) => Promise<void>;
}) {
  const forkScenePhase = ref<"idle" | "prepare" | "leave" | "swap" | "enter">("idle");
  const forkSceneToken = ref(0);
  const forkSceneSwitching = ref(false);
  const forkSceneTargetSessionId = ref("");
  const forkSessionHighlight = ref(false);
  let forkSessionHighlightTimer: ReturnType<typeof setTimeout> | null = null;

  const isForkSceneActive = computed(() => forkScenePhase.value !== "idle");

  const chatSceneClass = computed(() => ({
    "chat-scene--prepare": forkScenePhase.value === "prepare",
    "chat-scene--leave": forkScenePhase.value === "leave" || forkScenePhase.value === "swap",
    "chat-scene--enter": forkScenePhase.value === "enter",
  }));

  const forkSceneProgressClass = computed(() => {
    if (forkScenePhase.value === "prepare") return "w-[30%]";
    if (forkScenePhase.value === "enter") return "w-full";
    return "w-[74%]";
  });

  const forkSceneIconClass = computed(() =>
    forkScenePhase.value === "enter" ? "animate-pulse" : "animate-spin"
  );

  function setForkSessionHighlight(active: boolean) {
    forkSessionHighlight.value = active;
  }

  function triggerForkSessionHighlight() {
    if (forkSessionHighlightTimer) {
      clearTimeout(forkSessionHighlightTimer);
      forkSessionHighlightTimer = null;
    }
    setForkSessionHighlight(true);
    forkSessionHighlightTimer = setTimeout(() => {
      setForkSessionHighlight(false);
      forkSessionHighlightTimer = null;
    }, FORK_SWITCH_HIGHLIGHT_MS);
  }

  function bumpForkSceneToken() {
    forkSceneToken.value += 1;
    return forkSceneToken.value;
  }

  function isForkSceneStale(token: number) {
    return token !== forkSceneToken.value;
  }

  function resetForkSceneState() {
    forkScenePhase.value = "idle";
    forkSceneSwitching.value = false;
    forkSceneTargetSessionId.value = "";
  }

  async function playForkSceneSwitch(targetSessionId: string) {
    const normalizedTargetSessionId = String(targetSessionId || "").trim();
    if (!normalizedTargetSessionId) return;

    const token = bumpForkSceneToken();
    forkSceneSwitching.value = true;
    forkSceneTargetSessionId.value = normalizedTargetSessionId;

    try {
      forkScenePhase.value = "prepare";
      await sleep(USER_FORK_SCENE_PREPARE_MS);
      if (isForkSceneStale(token)) return;

      forkScenePhase.value = "leave";
      await sleep(USER_FORK_SCENE_LEAVE_MS);
      if (isForkSceneStale(token)) return;

      forkScenePhase.value = "swap";
      await deps.loadSession(normalizedTargetSessionId);
      if (isForkSceneStale(token)) return;

      triggerForkSessionHighlight();
      await nextTick();

      forkScenePhase.value = "enter";
      await sleep(USER_FORK_SCENE_ENTER_MS);
    } finally {
      if (!isForkSceneStale(token)) {
        resetForkSceneState();
      }
    }
  }

  async function switchForkSessionWithScene(
    targetSessionId: string,
    options: { startedAt?: number } = {}
  ) {
    const normalizedTargetSessionId = String(targetSessionId || "").trim();
    if (!normalizedTargetSessionId) return;

    const startedAt = Number.isFinite(Number(options.startedAt)) ? Number(options.startedAt) : Date.now();
    const elapsed = Date.now() - startedAt;
    if (elapsed < USER_FORK_MIN_VISIBLE_MS) {
      await sleep(USER_FORK_MIN_VISIBLE_MS - elapsed);
    }
    await playForkSceneSwitch(normalizedTargetSessionId);
  }

  function isExpectedSwitch(sessionId: string): boolean {
    return forkSceneSwitching.value && sessionId.length > 0 && sessionId === forkSceneTargetSessionId.value;
  }

  function setHighlight(active: boolean) {
    forkSessionHighlight.value = active;
  }

  function cleanup() {
    if (forkSessionHighlightTimer) {
      clearTimeout(forkSessionHighlightTimer);
      forkSessionHighlightTimer = null;
    }
    bumpForkSceneToken();
    resetForkSceneState();
  }

  return {
    forkScenePhase,
    forkSceneSwitching,
    forkSessionHighlight,
    isForkSceneActive,
    chatSceneClass,
    forkSceneProgressClass,
    forkSceneIconClass,
    playForkSceneSwitch,
    switchForkSessionWithScene,
    resetForkSceneState,
    bumpForkSceneToken,
    isExpectedSwitch,
    setHighlight,
    cleanup,
  };
}
