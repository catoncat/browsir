import { describe, expect, test } from "bun:test";
import { resolveVisualReviewConfig, runLlmVisualReview } from "../lib/visual-review";

describe("resolveVisualReviewConfig", () => {
  test("默认 optional，并回退到 live 配置", () => {
    const cfg = resolveVisualReviewConfig({
      env: {} as NodeJS.ProcessEnv,
      liveLlmBase: "https://ai.example/v1",
      liveLlmKey: "k-live",
      liveLlmModel: "m-live"
    });

    expect(cfg.mode).toBe("optional");
    expect(cfg.llmApiBase).toBe("https://ai.example/v1");
    expect(cfg.llmApiKey).toBe("k-live");
    expect(cfg.llmModel).toBe("m-live");
    expect(cfg.timeoutMs).toBeGreaterThanOrEqual(5_000);
  });

  test("支持 required/off 模式", () => {
    const required = resolveVisualReviewConfig({
      env: {
        BRAIN_E2E_VISUAL_REVIEW_MODE: "required"
      } as NodeJS.ProcessEnv
    });
    const off = resolveVisualReviewConfig({
      env: {
        BRAIN_E2E_VISUAL_REVIEW_MODE: "off"
      } as NodeJS.ProcessEnv
    });

    expect(required.mode).toBe("required");
    expect(off.mode).toBe("off");
  });
});

describe("runLlmVisualReview", () => {
  test("mode=off 时直接 skipped", async () => {
    const report = await runLlmVisualReview({
      caseId: "case-off",
      caseName: "off",
      objective: "obj",
      rubric: ["rule"],
      images: [{ label: "shot", base64: "ZmFrZQ==", mimeType: "image/png", path: "a.png" }],
      config: {
        mode: "off",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "gpt-5.3-codex",
        timeoutMs: 10_000
      }
    });

    expect(report.status).toBe("skipped");
    expect(report.verdict).toBe("unknown");
  });

  test("mode=required 且缺少配置时返回 error", async () => {
    const report = await runLlmVisualReview({
      caseId: "case-required",
      caseName: "required",
      objective: "obj",
      rubric: ["rule"],
      images: [{ label: "shot", base64: "ZmFrZQ==", mimeType: "image/png", path: "a.png" }],
      config: {
        mode: "required",
        llmApiBase: "",
        llmApiKey: "",
        llmModel: "gpt-5.3-codex",
        timeoutMs: 10_000
      }
    });

    expect(report.status).toBe("error");
    expect(report.verdict).toBe("unknown");
  });
});

