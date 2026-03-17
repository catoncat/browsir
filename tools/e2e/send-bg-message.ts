import type { CdpClient } from "./cdp-client";
import type { RuntimeMessageResponse } from "./types";

function normalizeConfigSavePayload(rawPayload: unknown): Record<string, unknown> {
  const payload =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? ({ ...(rawPayload as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const defaultProfile = String(payload.llmDefaultProfile || "default").trim() || "default";
  const existingProfiles = Array.isArray(payload.llmProfiles)
    ? payload.llmProfiles
    : payload.llmProfiles && typeof payload.llmProfiles === "object"
      ? Object.values(payload.llmProfiles as Record<string, unknown>)
      : [];

  if (existingProfiles.length > 0) {
    payload.llmDefaultProfile = defaultProfile;
    return payload;
  }

  const llmApiBase = String(payload.llmApiBase || "").trim();
  const llmApiKey = String(payload.llmApiKey ?? "");
  const llmModel = String(payload.llmModel || "gpt-5.3-codex").trim() || "gpt-5.3-codex";
  const llmTimeoutMsRaw = Number(payload.llmTimeoutMs);
  const llmRetryMaxAttemptsRaw = Number(payload.llmRetryMaxAttempts);
  const llmMaxRetryDelayMsRaw = Number(payload.llmMaxRetryDelayMs);

  const profile: Record<string, unknown> = {
    id: defaultProfile,
    provider: "openai_compatible",
    llmApiBase,
    llmApiKey,
    llmModel,
    role: "worker"
  };
  if (Number.isFinite(llmTimeoutMsRaw)) profile.llmTimeoutMs = Math.max(1_000, Math.floor(llmTimeoutMsRaw));
  if (Number.isFinite(llmRetryMaxAttemptsRaw)) profile.llmRetryMaxAttempts = Math.max(0, Math.floor(llmRetryMaxAttemptsRaw));
  if (Number.isFinite(llmMaxRetryDelayMsRaw)) profile.llmMaxRetryDelayMs = Math.max(0, Math.floor(llmMaxRetryDelayMsRaw));

  payload.llmDefaultProfile = defaultProfile;
  payload.llmProfiles = [profile];
  delete payload.llmApiBase;
  delete payload.llmApiKey;
  delete payload.llmModel;
  return payload;
}

export async function sendBgMessage(sidepanel: CdpClient, message: Record<string, unknown>): Promise<RuntimeMessageResponse> {
  const normalizedMessage =
    String(message?.type || "") === "config.save"
      ? {
          ...message,
          payload: normalizeConfigSavePayload(message.payload)
        }
      : message;
  const serialized = JSON.stringify(normalizedMessage);
  const expr = `(async () => {
    const msg = ${serialized};
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => done({ ok: false, error: "runtime.sendMessage timeout" }), 15000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) {
            done({ ok: false, error: err.message || String(err) });
            return;
          }
          done(resp ?? { ok: false, error: "empty response" });
        });
      } catch (err) {
        clearTimeout(timer);
        done({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  })()`;

  return (await sidepanel.evaluate(expr)) as RuntimeMessageResponse;
}
