const MASCOT_SOURCE = "plugin.ui.mission-hud";
let mascotSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function toStringList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const text = String(item || "").trim();
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function fireRuntimeMessage(payload) {
  try {
    const maybePromise = chrome.runtime.sendMessage(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {});
    }
  } catch {
    // ignore
  }
}

function emitMascot(phase, message, options = {}) {
  mascotSeq += 1;
  const sessionId = String(options.sessionId || "").trim();
  fireRuntimeMessage({
    type: "bbloop.ui.mascot",
    payload: {
      phase,
      message,
      source: MASCOT_SOURCE,
      sessionId,
      durationMs: options.durationMs,
      dedupeKey: `${MASCOT_SOURCE}:${sessionId || "global"}:${Date.now()}:${mascotSeq}`,
      ts: nowIso()
    }
  });
}

function clip(input, max = 48) {
  const text = String(input || "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function prettyAction(action) {
  const text = String(action || "").trim();
  if (!text) return "步骤";
  return text.replaceAll("_", " ");
}

export default function registerMissionHudDog(pi) {
  pi.on("runtime.route.after", (event) => {
    const routeType = String(event?.type || "").trim();
    if (routeType !== "brain.run.start" && routeType !== "brain.run.stop") {
      return { action: "continue" };
    }
    const routeResult = toRecord(event?.result);
    const routeMessage = toRecord(event?.message);
    if (routeType === "brain.run.start") {
      if (routeResult.ok !== true) return { action: "continue" };
      const prompt = String(routeMessage.prompt || "").trim();
      const skillIds = toStringList(routeMessage.skillIds);
      if (!prompt && skillIds.length === 0) return { action: "continue" };
      const data = toRecord(routeResult.data);
      const sessionId = String(data.sessionId || routeMessage.sessionId || "").trim();
      emitMascot("thinking", "汪！我先闻闻线索，马上开始。", { sessionId, durationMs: 3000 });
    } else {
      const sessionId = String(routeMessage.sessionId || "").trim();
      emitMascot("done", "收到停止指令，我已经停下啦。", { sessionId, durationMs: 2200 });
    }
    return { action: "continue" };
  });

  pi.on("tool.before_call", (event) => {
    const input = toRecord(event?.input);
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    emitMascot("tool", `我去执行：${prettyAction(String(input.action || ""))}`, {
      sessionId,
      durationMs: 2200
    });
    return { action: "continue" };
  });

  pi.on("step.after_execute", (event) => {
    const input = toRecord(event?.input);
    const result = toRecord(event?.result);
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    if (result.ok !== true) {
      const errorText = clip(String(result.error || ""));
      emitMascot("error", errorText ? `唔，出错了：${errorText}` : "唔，这一步失败了。", {
        sessionId,
        durationMs: 3600
      });
      return { action: "continue" };
    }
    emitMascot("verify", result.verified === true ? "我核对过了，这一步通过。" : "步骤完成，我继续盯着变化。", {
      sessionId,
      durationMs: result.verified === true ? 1800 : 1500
    });
    return { action: "continue" };
  });

  pi.on("agent_end.after", (event) => {
    const input = toRecord(event?.input);
    const decision = toRecord(event?.decision);
    const sessionId = String(decision.sessionId || input.sessionId || "").trim();
    if (!sessionId) return { action: "continue" };
    const action = String(decision.action || "").trim();
    if (action === "retry") {
      emitMascot("thinking", "刚才有点小插曲，我再试一次。", { sessionId, durationMs: 2800 });
      return { action: "continue" };
    }
    if (action !== "done") return { action: "continue" };
    const errorText = clip(String(toRecord(input.error).message || ""));
    if (errorText) {
      emitMascot("error", `这轮遇到问题：${errorText}`, { sessionId, durationMs: 3800 });
      return { action: "continue" };
    }
    emitMascot("done", "任务完成！我摇着尾巴汇报完毕。", { sessionId, durationMs: 2600 });
    return { action: "continue" };
  });
}
