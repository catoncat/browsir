const NOTICE_SOURCE = "plugin.send-success-global-message";
const SUCCESS_MESSAGE = "发送成功";
const MAX_DEDUP_SIZE = 120;

function toRecord(value) {
  return value && typeof value === "object" ? value : {};
}

export default function registerSendSuccessUiPlugin(ui) {
  const seen = new Map();

  ui.on("ui.notice.before_show", (event) => {
    const source = String(event?.source || "").trim();
    if (source !== NOTICE_SOURCE) {
      return { action: "continue" };
    }

    const sessionId = String(event?.sessionId || "").trim();
    const message = String(event?.message || "").trim() || SUCCESS_MESSAGE;
    const dedupeKey = String(event?.dedupeKey || `${source}:${sessionId}:${message}`).trim();
    if (dedupeKey && seen.has(dedupeKey)) {
      return {
        action: "block",
        reason: "duplicate_notice"
      };
    }

    if (dedupeKey) {
      seen.set(dedupeKey, Date.now());
      if (seen.size > MAX_DEDUP_SIZE) {
        const first = seen.keys().next();
        if (!first.done) seen.delete(first.value);
      }
    }

    return {
      action: "patch",
      patch: {
        type: "success",
        message,
        durationMs: Number(event?.durationMs) > 0 ? Number(event.durationMs) : 2200,
        dedupeKey
      }
    };
  });

  ui.on("ui.runtime.event", (event) => {
    const message = toRecord(event?.message);
    if (String(message.type || "").trim() !== "bbloop.global.message") {
      return { action: "continue" };
    }
    const payload = toRecord(message.payload);
    if (String(payload.source || "").trim() !== NOTICE_SOURCE) {
      return { action: "continue" };
    }
    if (String(payload.message || "").trim()) {
      return { action: "continue" };
    }
    return {
      action: "patch",
      patch: {
        message: {
          ...message,
          payload: {
            ...payload,
            message: SUCCESS_MESSAGE
          }
        }
      }
    };
  });
}
