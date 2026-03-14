const STYLE_ID = "plugin-example-mission-hud-dog-style";
const PLUGIN_ID = "plugin.example.ui.mission-hud.dog";
const WIDGET_ID = "mission-hud-dog";

function ensureStyle(doc) {
  if (!doc?.head) return;
  if (doc.getElementById?.(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-plugin-widget-instance="${PLUGIN_ID}:${WIDGET_ID}"] {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: 20px;
      pointer-events: none;
      z-index: 1;
    }

    .mission-hud-dog {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      opacity: 0;
      transform: translateY(10px) scale(0.96);
      transition: opacity 180ms ease, transform 180ms ease;
      filter: drop-shadow(0 10px 24px rgba(15, 23, 42, 0.16));
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }

    .mission-hud-dog[data-visible="true"] {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .mission-hud-dog__bubble {
      max-width: min(300px, calc(100vw - 120px));
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.96);
      color: #0f172a;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.45;
      font-weight: 600;
      backdrop-filter: blur(10px);
    }

    .mission-hud-dog__phase {
      display: block;
      margin-bottom: 4px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #475569;
    }

    .mission-hud-dog__pet {
      width: 64px;
      height: 64px;
      border-radius: 18px;
      background: linear-gradient(180deg, #fff7ed 0%, #fed7aa 100%);
      border: 1px solid rgba(251, 146, 60, 0.35);
      display: grid;
      place-items: center;
      position: relative;
      overflow: hidden;
    }

    .mission-hud-dog__pet::before,
    .mission-hud-dog__pet::after {
      content: "";
      position: absolute;
      top: 10px;
      width: 15px;
      height: 22px;
      border-radius: 999px;
      background: #fdba74;
      border: 1px solid rgba(251, 146, 60, 0.25);
    }

    .mission-hud-dog__pet::before { left: 10px; transform: rotate(-20deg); }
    .mission-hud-dog__pet::after { right: 10px; transform: rotate(20deg); }

    .mission-hud-dog__face {
      position: relative;
      width: 36px;
      height: 30px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.72);
      margin-top: 10px;
    }

    .mission-hud-dog__face::before,
    .mission-hud-dog__face::after {
      content: "";
      position: absolute;
      top: 10px;
      width: 5px;
      height: 5px;
      border-radius: 999px;
      background: #0f172a;
    }

    .mission-hud-dog__face::before { left: 9px; }
    .mission-hud-dog__face::after { right: 9px; }

    .mission-hud-dog__nose {
      position: absolute;
      left: 50%;
      top: 14px;
      width: 8px;
      height: 6px;
      border-radius: 999px;
      background: #7c2d12;
      transform: translateX(-50%);
    }

    .mission-hud-dog__mouth {
      position: absolute;
      left: 50%;
      top: 20px;
      width: 12px;
      height: 6px;
      border-bottom: 2px solid #7c2d12;
      border-radius: 0 0 999px 999px;
      transform: translateX(-50%);
    }

    .mission-hud-dog[data-phase="thinking"] .mission-hud-dog__pet,
    .mission-hud-dog[data-phase="tool"] .mission-hud-dog__pet,
    .mission-hud-dog[data-phase="verify"] .mission-hud-dog__pet {
      animation: mission-hud-dog-bob 1.2s ease-in-out infinite;
    }

    .mission-hud-dog[data-phase="error"] .mission-hud-dog__bubble {
      border-color: rgba(248, 113, 113, 0.3);
      background: rgba(255, 241, 242, 0.96);
      color: #9f1239;
    }

    .mission-hud-dog[data-phase="done"] .mission-hud-dog__bubble {
      border-color: rgba(74, 222, 128, 0.28);
      background: rgba(240, 253, 244, 0.96);
      color: #166534;
    }

    @keyframes mission-hud-dog-bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-3px); }
    }
  `;
  doc.head.appendChild(style);
}

function normalizePhase(raw) {
  const phase = String(raw || "").trim().toLowerCase();
  if (phase === "tool" || phase === "verify" || phase === "done" || phase === "error") {
    return phase;
  }
  return "thinking";
}

function normalizePayload(input) {
  const row = input && typeof input === "object" ? input : {};
  const message = String(row.message || row.text || "").trim();
  if (!message) return null;
  const durationMs = Number(row.durationMs);
  return {
    phase: normalizePhase(row.phase),
    message,
    sessionId: String(row.sessionId || "").trim() || undefined,
    durationMs: Number.isFinite(durationMs) ? Math.max(800, Math.min(15000, Math.floor(durationMs))) : 2400
  };
}

function phaseLabel(phase) {
  if (phase === "tool") return "执行工具";
  if (phase === "verify") return "结果验证";
  if (phase === "done") return "完成";
  if (phase === "error") return "异常";
  return "思考中";
}

export default function registerMissionHudDogUi(ui) {
  ui.registerWidget({
    id: WIDGET_ID,
    slot: "chat.scene.overlay",
    order: 20,
    mount(container, context) {
      const doc = container.ownerDocument || document;
      ensureStyle(doc);

      const root = doc.createElement("div");
      root.className = "mission-hud-dog";
      root.dataset.visible = "false";
      root.dataset.phase = "thinking";

      const bubble = doc.createElement("div");
      bubble.className = "mission-hud-dog__bubble";

      const phase = doc.createElement("span");
      phase.className = "mission-hud-dog__phase";
      phase.textContent = phaseLabel("thinking");

      const text = doc.createElement("div");
      text.textContent = "汪，我已就位。";

      bubble.appendChild(phase);
      bubble.appendChild(text);

      const pet = doc.createElement("div");
      pet.className = "mission-hud-dog__pet";

      const face = doc.createElement("div");
      face.className = "mission-hud-dog__face";

      const nose = doc.createElement("span");
      nose.className = "mission-hud-dog__nose";

      const mouth = doc.createElement("span");
      mouth.className = "mission-hud-dog__mouth";

      face.appendChild(nose);
      face.appendChild(mouth);
      pet.appendChild(face);

      root.appendChild(bubble);
      root.appendChild(pet);
      container.appendChild(root);

      let hideTimer = null;

      const clearHideTimer = () => {
        if (!hideTimer) return;
        clearTimeout(hideTimer);
        hideTimer = null;
      };

      const hide = () => {
        root.dataset.visible = "false";
      };

      const reset = () => {
        clearHideTimer();
        hide();
        root.dataset.phase = "thinking";
        phase.textContent = phaseLabel("thinking");
        text.textContent = "汪，我已就位。";
      };

      const show = (payload) => {
        const next = normalizePayload(payload);
        if (!next) return;
        if (!context.isActiveSession(next.sessionId)) return;
        root.dataset.phase = next.phase;
        root.dataset.visible = "true";
        phase.textContent = phaseLabel(next.phase);
        text.textContent = next.message;
        clearHideTimer();
        hideTimer = setTimeout(() => {
          hide();
          hideTimer = null;
        }, next.durationMs);
      };

      const onMessage = (message) => {
        const type = String(message?.type || "").trim();
        if (type !== "bbloop.ui.mascot") return;
        show(message?.payload);
      };

      chrome.runtime.onMessage.addListener(onMessage);
      const stopWatchingSession = typeof context?.onActiveSessionChanged === "function"
        ? context.onActiveSessionChanged(() => {
            reset();
          })
        : null;

      return () => {
        clearHideTimer();
        stopWatchingSession?.();
        chrome.runtime.onMessage.removeListener(onMessage);
        root.remove();
      };
    }
  });
}
