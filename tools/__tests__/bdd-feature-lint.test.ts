import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { runBddFeatureLint } from "../bdd-feature-lint";

type ContractCategory = "ux" | "protocol" | "storage";

interface FixtureOptions {
  category: ContractCategory;
  featurePath: string;
  featureBody: string;
}

function sampleContract(contractId: string) {
  return {
    id: contractId,
    intent: "sample intent",
    context: {
      gate_profile: "default"
    },
    steps: ["given sample"],
    observables: ["sample observable"],
    risk: "low",
    allowed_side_effects: ["none"],
    proof_requirements: {
      required_layers: ["browser-cdp"],
      min_layers: 1
    },
    degrade_policy: {
      fallback: "none"
    },
    version: "1.0.0"
  };
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createFixture(options: FixtureOptions): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bdd-feature-lint-"));
  const contractId = "BHV-SAMPLE-FEATURE-LINT";

  await writeJson(path.join(repoRoot, "bdd/schemas/behavior-contract.schema.json"), {});
  await writeJson(
    path.join(repoRoot, "bdd/contracts/chat/BHV-SAMPLE-FEATURE-LINT.v1.json"),
    sampleContract(contractId)
  );

  await writeJson(path.join(repoRoot, "bdd/mappings/contract-categories.json"), {
    version: "1.0.0",
    mappings: [
      {
        contractId,
        category: options.category
      }
    ]
  });

  await writeJson(path.join(repoRoot, "bdd/mappings/contract-to-tests.json"), {
    version: "1.0.0",
    mappings: [
      {
        contractId,
        proofs: [
          {
            layer: "browser-cdp",
            target: options.featurePath
          }
        ]
      }
    ]
  });

  const featureAbs = path.join(repoRoot, options.featurePath);
  await mkdir(path.dirname(featureAbs), { recursive: true });
  await writeFile(featureAbs, options.featureBody, "utf8");

  return repoRoot;
}

describe("runBddFeatureLint", () => {
  test("passes when ux feature is under business layer with business wording", async () => {
    const repoRoot = await createFixture({
      category: "ux",
      featurePath: "bdd/features/business/chat/sample.feature",
      featureBody: `@contract(BHV-SAMPLE-FEATURE-LINT)\nFeature: Sample\n\n  Scenario: Business scenario\n    Given 用户已进入会话\n    When 用户发送消息\n    Then 系统返回可读结果\n`
    });

    try {
      const result = await runBddFeatureLint(repoRoot);
      expect(result.errors).toHaveLength(0);
      expect(result.counts.features).toBe(1);
      expect(result.counts.business).toBe(1);
      expect(result.counts.technical).toBe(0);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("fails when ux feature is incorrectly placed under technical layer", async () => {
    const repoRoot = await createFixture({
      category: "ux",
      featurePath: "bdd/features/technical/chat/sample.feature",
      featureBody: `@contract(BHV-SAMPLE-FEATURE-LINT)\nFeature: Sample\n\n  Scenario: Layer mismatch\n    Given 用户已进入会话\n    When 用户发送消息\n    Then 系统返回可读结果\n`
    });

    try {
      const result = await runBddFeatureLint(repoRoot);
      expect(result.errors.some((x) => x.includes("category=ux") && x.includes("business"))).toBeTrue();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("fails when business feature contains implementation detail keywords", async () => {
    const repoRoot = await createFixture({
      category: "ux",
      featurePath: "bdd/features/business/chat/sample.feature",
      featureBody: `@contract(BHV-SAMPLE-FEATURE-LINT)\nFeature: Sample\n\n  Scenario: Forbidden token\n    Given 用户已进入会话\n    When 用户点击操作\n    Then 应看到 aria-label 为 "复制内容" 的按钮\n`
    });

    try {
      const result = await runBddFeatureLint(repoRoot);
      expect(result.errors.some((x) => x.includes("aria-label") && x.includes("business feature 命中实现细节词"))).toBeTrue();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("fails when feature is outside business/technical directories", async () => {
    const repoRoot = await createFixture({
      category: "ux",
      featurePath: "bdd/features/chat/sample.feature",
      featureBody: `@contract(BHV-SAMPLE-FEATURE-LINT)\nFeature: Sample\n\n  Scenario: Wrong directory\n    Given 用户已进入会话\n    When 用户发送消息\n    Then 系统返回可读结果\n`
    });

    try {
      const result = await runBddFeatureLint(repoRoot);
      expect(result.errors.some((x) => x.includes("feature 必须放在 bdd/features/business/** 或 bdd/features/technical/**"))).toBeTrue();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
