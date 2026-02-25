export type VisualReviewMode = "off" | "optional" | "required";

export interface VisualReviewRuntimeConfig {
  mode: VisualReviewMode;
  llmApiBase: string;
  llmApiKey: string;
  llmModel: string;
  timeoutMs: number;
}

export interface ResolveVisualReviewConfigInput {
  env?: NodeJS.ProcessEnv;
  liveLlmBase?: string;
  liveLlmKey?: string;
  liveLlmModel?: string;
}

export interface VisualReviewImageInput {
  label: string;
  base64: string;
  mimeType?: string;
  path?: string;
}

export interface VisualReviewRequest {
  caseId: string;
  caseName: string;
  objective: string;
  rubric: string[];
  context?: unknown;
  images: VisualReviewImageInput[];
  config: VisualReviewRuntimeConfig;
}

export interface VisualReviewReport {
  caseId: string;
  caseName: string;
  mode: VisualReviewMode;
  status: "passed" | "failed" | "skipped" | "error";
  verdict: "pass" | "fail" | "unknown";
  reviewer: {
    base: string;
    model: string;
  };
  durationMs: number;
  reason?: string;
  summary: string;
  observations: string[];
  issues: string[];
  screenshotPaths: string[];
  rawResponseText?: string;
}

function toTrimmed(value: unknown): string {
  return String(value || "").trim();
}

function normalizeMode(value: unknown): VisualReviewMode {
  const raw = toTrimmed(value).toLowerCase();
  if (raw === "off") return "off";
  if (raw === "required") return "required";
  if (raw === "optional") return "optional";
  return "optional";
}

function normalizeTimeoutMs(value: unknown, fallback = 40_000): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(5_000, Math.min(120_000, Math.round(n)));
}

function clipText(value: unknown, maxChars = 6_000): string {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...(truncated ${text.length - maxChars} chars)`;
}

function toTextArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => clipText(item, 500)).map((item) => item.trim()).filter(Boolean);
}

function extractResponseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as any).text;
    if (typeof text === "string" && text.trim()) {
      parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const raw = toTrimmed(text);
  if (!raw) return null;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fromFence = toTrimmed(fenceMatch?.[1] || "");
  if (fromFence) {
    try {
      const parsed = JSON.parse(fromFence);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  const left = raw.indexOf("{");
  const right = raw.lastIndexOf("}");
  if (left >= 0 && right > left) {
    const sliced = raw.slice(left, right + 1);
    try {
      const parsed = JSON.parse(sliced);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function buildReviewerPrompt(input: VisualReviewRequest): string {
  const rubricLines = input.rubric.map((item, idx) => `${idx + 1}. ${item}`).join("\n");
  const contextText = input.context === undefined ? "" : clipText(JSON.stringify(input.context, null, 2), 16_000);
  return [
    "请执行严格的视觉回归评审，只输出 JSON，不要输出其他文本。",
    "",
    "输出格式：",
    "{",
    '  "verdict": "pass|fail",',
    '  "summary": "一句话结论",',
    '  "observations": ["可读性/高亮/布局等客观观察"],',
    '  "issues": ["发现的问题（若无可空数组）"]',
    "}",
    "",
    `评审目标：${input.objective}`,
    "评审准则：",
    rubricLines,
    "",
    contextText ? `结构化上下文（供参考）：\n${contextText}` : "结构化上下文：无"
  ].join("\n");
}

export function resolveVisualReviewConfig(input: ResolveVisualReviewConfigInput = {}): VisualReviewRuntimeConfig {
  const env = input.env || process.env;
  const mode = normalizeMode(env.BRAIN_E2E_VISUAL_REVIEW_MODE);
  const llmApiBase = toTrimmed(env.BRAIN_E2E_VISUAL_REVIEW_BASE) || toTrimmed(input.liveLlmBase);
  const llmApiKey = toTrimmed(env.BRAIN_E2E_VISUAL_REVIEW_KEY) || toTrimmed(input.liveLlmKey);
  const llmModel = toTrimmed(env.BRAIN_E2E_VISUAL_REVIEW_MODEL) || toTrimmed(input.liveLlmModel) || "gpt-5.3-codex";
  const timeoutMs = normalizeTimeoutMs(env.BRAIN_E2E_VISUAL_REVIEW_TIMEOUT_MS, 40_000);
  return {
    mode,
    llmApiBase,
    llmApiKey,
    llmModel,
    timeoutMs
  };
}

export async function runLlmVisualReview(input: VisualReviewRequest): Promise<VisualReviewReport> {
  const started = Date.now();
  const screenshotPaths = input.images.map((item) => toTrimmed(item.path)).filter(Boolean);
  const reviewer = {
    base: input.config.llmApiBase,
    model: input.config.llmModel
  };

  if (input.config.mode === "off") {
    return {
      caseId: input.caseId,
      caseName: input.caseName,
      mode: input.config.mode,
      status: "skipped",
      verdict: "unknown",
      reviewer,
      durationMs: Date.now() - started,
      reason: "visual review mode is off",
      summary: "视觉评审已关闭",
      observations: [],
      issues: [],
      screenshotPaths
    };
  }

  if (!input.images.length) {
    return {
      caseId: input.caseId,
      caseName: input.caseName,
      mode: input.config.mode,
      status: "error",
      verdict: "unknown",
      reviewer,
      durationMs: Date.now() - started,
      reason: "missing screenshots",
      summary: "未提供截图，无法评审",
      observations: [],
      issues: ["missing screenshots"],
      screenshotPaths
    };
  }

  if (!input.config.llmApiBase || !input.config.llmApiKey) {
    const reason = "missing visual review llm config";
    if (input.config.mode === "required") {
      return {
        caseId: input.caseId,
        caseName: input.caseName,
        mode: input.config.mode,
        status: "error",
        verdict: "unknown",
        reviewer,
        durationMs: Date.now() - started,
        reason,
        summary: "缺少视觉评审 LLM 配置",
        observations: [],
        issues: [reason],
        screenshotPaths
      };
    }
    return {
      caseId: input.caseId,
      caseName: input.caseName,
      mode: input.config.mode,
      status: "skipped",
      verdict: "unknown",
      reviewer,
      durationMs: Date.now() - started,
      reason,
      summary: "缺少视觉评审 LLM 配置，已跳过",
      observations: [],
      issues: [],
      screenshotPaths
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("visual-review-timeout"), input.config.timeoutMs);
  try {
    const prompt = buildReviewerPrompt(input);
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    for (const [index, image] of input.images.entries()) {
      const mimeType = toTrimmed(image.mimeType) || "image/png";
      content.push({ type: "text", text: `截图 #${index + 1}: ${image.label}` });
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${image.base64}`,
          detail: "high"
        }
      });
    }

    const response = await fetch(`${input.config.llmApiBase.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.config.llmApiKey}`
      },
      body: JSON.stringify({
        model: input.config.llmModel,
        temperature: 0,
        stream: false,
        messages: [
          {
            role: "system",
            content: "你是严格的视觉回归评审器。只返回 JSON。不要输出解释性段落。"
          },
          {
            role: "user",
            content
          }
        ]
      }),
      signal: ctrl.signal
    });

    const rawBody = await response.text();
    if (!response.ok) {
      return {
        caseId: input.caseId,
        caseName: input.caseName,
        mode: input.config.mode,
        status: "error",
        verdict: "unknown",
        reviewer,
        durationMs: Date.now() - started,
        reason: `visual review llm http ${response.status}`,
        summary: "视觉评审请求失败",
        observations: [],
        issues: [clipText(rawBody, 1_200)],
        screenshotPaths,
        rawResponseText: clipText(rawBody, 2_000)
      };
    }

    let payload: any = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }
    const message = payload?.choices?.[0]?.message;
    const responseText = extractResponseText(message?.content);
    const parsed = tryParseJson(responseText);

    const verdictRaw = toTrimmed(parsed?.verdict).toLowerCase();
    const verdict: "pass" | "fail" | "unknown" =
      verdictRaw === "pass" ? "pass" : verdictRaw === "fail" ? "fail" : "unknown";
    const summary = toTrimmed(parsed?.summary) || (verdict === "pass" ? "LLM 视觉评审通过" : "LLM 视觉评审未通过");
    const observations = toTextArray(parsed?.observations);
    const issues = toTextArray(parsed?.issues);

    return {
      caseId: input.caseId,
      caseName: input.caseName,
      mode: input.config.mode,
      status: verdict === "pass" ? "passed" : verdict === "fail" ? "failed" : "error",
      verdict,
      reviewer,
      durationMs: Date.now() - started,
      reason: verdict === "unknown" ? "unrecognized review response format" : undefined,
      summary,
      observations,
      issues,
      screenshotPaths,
      rawResponseText: clipText(responseText || rawBody, 2_000)
    };
  } catch (error) {
    const errText = error instanceof Error ? error.message : String(error);
    return {
      caseId: input.caseId,
      caseName: input.caseName,
      mode: input.config.mode,
      status: "error",
      verdict: "unknown",
      reviewer,
      durationMs: Date.now() - started,
      reason: errText,
      summary: "视觉评审执行异常",
      observations: [],
      issues: [clipText(errText, 1_000)],
      screenshotPaths
    };
  } finally {
    clearTimeout(timer);
  }
}

