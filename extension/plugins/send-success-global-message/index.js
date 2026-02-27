const GLOBAL_MESSAGE_EVENT_TYPE = "bbloop.global.message";
const FALLBACK_EVENT_TYPE = "plugin.global_message";
const SUCCESS_MESSAGE = "发送成功";
const MAX_DEDUP_SIZE = 200;

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

function toStringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
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

function buildDedupKey(routeMessage, routeResult) {
  const req = toRecord(routeMessage);
  const res = toRecord(routeResult);
  const data = toRecord(res.data);
  const sessionId = String(data.sessionId || req.sessionId || "").trim();
  const prompt = String(req.prompt || "").trim();
  const skillIds = toStringList(req.skillIds).join(",");
  return `${sessionId}::${prompt}::${skillIds}`;
}

function shouldNotifyForRunStart(routeMessage, routeResult) {
  const req = toRecord(routeMessage);
  const res = toRecord(routeResult);
  if (res.ok !== true) return false;
  const prompt = String(req.prompt || "").trim();
  const skillIds = toStringList(req.skillIds);
  if (prompt) return true;
  if (skillIds.length > 0) return true;
  return false;
}

export default function registerSendSuccessPlugin(pi) {
  const seen = new Map();

  pi.on("runtime.route.after", (event) => {
    const routeType = String(event?.type || "").trim();
    if (routeType !== "brain.run.start") {
      return { action: "continue" };
    }

    const routeMessage = toRecord(event?.message);
    const routeResult = toRecord(event?.result);
    if (!shouldNotifyForRunStart(routeMessage, routeResult)) {
      return { action: "continue" };
    }

    const dedupKey = buildDedupKey(routeMessage, routeResult);
    if (dedupKey && seen.has(dedupKey)) {
      return { action: "continue" };
    }
    if (dedupKey) {
      seen.set(dedupKey, Date.now());
      if (seen.size > MAX_DEDUP_SIZE) {
        const first = seen.keys().next();
        if (!first.done) seen.delete(first.value);
      }
    }

    const data = toRecord(routeResult.data);
    const sessionId = String(data.sessionId || routeMessage.sessionId || "").trim();

    fireRuntimeMessage({
      type: GLOBAL_MESSAGE_EVENT_TYPE,
      payload: {
        kind: "success",
        message: SUCCESS_MESSAGE,
        source: "plugin.send-success-global-message",
        sessionId,
        ts: new Date().toISOString()
      }
    });

    if (sessionId) {
      fireRuntimeMessage({
        type: "brain.event",
        event: {
          sessionId,
          type: FALLBACK_EVENT_TYPE,
          payload: {
            kind: "success",
            message: SUCCESS_MESSAGE,
            source: "plugin.send-success-global-message"
          }
        }
      });
    }

    return { action: "continue" };
  });
}
