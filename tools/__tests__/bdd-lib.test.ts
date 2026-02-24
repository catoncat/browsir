import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  fileExistsInRepo,
  isEvidenceJsonTargetPath,
  isFeatureFileTargetPath,
  parseFeatureContractRefs,
  parseProofTargets,
  runStructuralValidation,
  validateEvidenceSelector
} from "../bdd-lib";

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sampleContract(contractId: string) {
  return {
    id: contractId,
    intent: "sample intent",
    context: { gate_profile: "default" },
    steps: ["given"],
    observables: ["then"],
    risk: "low",
    allowed_side_effects: ["none"],
    proof_requirements: {
      required_layers: ["browser-cdp"],
      min_layers: 1
    },
    degrade_policy: { fallback: "none" },
    version: "1.0.0"
  };
}

describe("parseFeatureContractRefs", () => {
  test("只解析真实 @contract 行，忽略注释", () => {
    const content = `
# @contract(BHV-COMMENT-1)
  # @contract(BHV-COMMENT-2)
@smoke @contract(BHV-REAL-1)
@contract("BHV-REAL-2")
Feature: Sample
`;
    expect(parseFeatureContractRefs(content)).toEqual(["BHV-REAL-1", "BHV-REAL-2"]);
  });
});

describe("parseProofTargets", () => {
  test("支持使用 + 显式分隔多个 target，并正确截取 selector", () => {
    const target =
      "extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts::service worker 重启后可恢复会话并继续同一 session 对话 + extension/src/sw/kernel/__tests__/runtime-router-interruption.browser.test.ts::user stop should not be treated as implicit interruption recovery";

    expect(parseProofTargets(target)).toEqual([
      {
        path: "extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts",
        selector: "service worker 重启后可恢复会话并继续同一 session 对话"
      },
      {
        path: "extension/src/sw/kernel/__tests__/runtime-router-interruption.browser.test.ts",
        selector: "user stop should not be treated as implicit interruption recovery"
      }
    ]);
  });

  test("多 target 缺少显式分隔符时应判定为非法", () => {
    const invalid =
      "extension/src/sw/kernel/a.test.ts::case a extension/src/sw/kernel/b.test.ts::case b";
    expect(parseProofTargets(invalid)).toEqual([]);
  });
});

describe("validateEvidenceSelector", () => {
  test("严格匹配 selector，不允许 includes 糊弄", () => {
    const tests = [
      { status: "passed", group: "brain.runtime", name: "LLM 可用时支持 tool_call 闭环" }
    ];
    const result = validateEvidenceSelector(tests, "tool_call 闭环");
    expect(result.ok).toBeFalse();
  });

  test("多个 token 需要命中不同 passed case", () => {
    const tests = [{ status: "passed", group: "brain.runtime", name: "重复 case" }];
    const result = validateEvidenceSelector(tests, "brain.runtime :: 重复 case||brain.runtime :: 重复 case");
    expect(result.ok).toBeFalse();
  });

  test("支持 group :: name 精确命中", () => {
    const tests = [
      { status: "passed", group: "brain.runtime", name: "case a" },
      { status: "passed", group: "brain.runtime", name: "case b" }
    ];
    const result = validateEvidenceSelector(tests, "brain.runtime :: case a||brain.runtime :: case b");
    expect(result.ok).toBeTrue();
  });

  test("name 重名时要求使用 group :: name，避免歧义命中", () => {
    const tests = [
      { status: "passed", group: "g1", name: "same-name" },
      { status: "passed", group: "g2", name: "same-name" }
    ];
    const result = validateEvidenceSelector(tests, "same-name");
    expect(result.ok).toBeFalse();
  });
});

describe("target path guards", () => {
  test("e2e target 必须是 bdd/evidence/*.json", () => {
    expect(isEvidenceJsonTargetPath("bdd/evidence/brain-e2e.latest.json")).toBeTrue();
    expect(isEvidenceJsonTargetPath("./bdd/evidence/brain-e2e.latest.json")).toBeTrue();
    expect(isEvidenceJsonTargetPath("bdd/evidence/live/brain-e2e.latest.json")).toBeFalse();
    expect(isEvidenceJsonTargetPath("tools/brain-e2e.ts")).toBeFalse();
  });

  test("browser-cdp target 必须是 .feature", () => {
    expect(isFeatureFileTargetPath("bdd/features/business/chat/x.feature")).toBeTrue();
    expect(isFeatureFileTargetPath("./bdd/features/business/chat/x.feature")).toBeTrue();
    expect(isFeatureFileTargetPath("bdd/features/business/chat/x.ts")).toBeFalse();
  });
});

describe("fileExistsInRepo", () => {
  test("阻止 ../ 逃逸仓库", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "bdd-lib-exists-"));
    const repoRoot = path.join(base, "repo");
    const inside = path.join(repoRoot, "inside.txt");
    const outside = path.join(base, "outside.txt");

    try {
      await mkdir(repoRoot, { recursive: true });
      await writeFile(inside, "inside\n", "utf8");
      await writeFile(outside, "outside\n", "utf8");

      expect(await fileExistsInRepo(repoRoot, "inside.txt")).toBeTrue();
      expect(await fileExistsInRepo(repoRoot, "../outside.txt")).toBeFalse();
      expect(await fileExistsInRepo(repoRoot, "/etc/passwd")).toBeFalse();

      const escapeLink = path.join(repoRoot, "escape-link.txt");
      try {
        await symlink(outside, escapeLink);
        expect(await fileExistsInRepo(repoRoot, "escape-link.txt")).toBeFalse();
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException)?.code || "");
        if (!["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code)) {
          throw error;
        }
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("runStructuralValidation", () => {
  test("能识别无 Scenario 的 feature", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "bdd-lib-struct-"));
    const contractId = "BHV-SAMPLE-NO-SCENARIO";
    const featurePath = "bdd/features/business/chat/no-scenario.feature";

    try {
      await writeJson(path.join(repoRoot, "bdd/schemas/behavior-contract.schema.json"), {});
      await writeJson(
        path.join(repoRoot, "bdd/contracts/chat/BHV-SAMPLE-NO-SCENARIO.v1.json"),
        sampleContract(contractId)
      );
      await writeJson(path.join(repoRoot, "bdd/mappings/contract-to-tests.json"), {
        version: "1.0.0",
        mappings: [
          {
            contractId,
            proofs: [
              {
                layer: "browser-cdp",
                target: featurePath
              }
            ]
          }
        ]
      });
      await mkdir(path.join(repoRoot, "bdd/features/business/chat"), { recursive: true });
      await writeFile(
        path.join(repoRoot, featurePath),
        `@contract(${contractId})\nFeature: Missing scenario\n`,
        "utf8"
      );

      const snapshot = await runStructuralValidation(repoRoot);
      expect(snapshot.featuresWithoutScenario).toEqual([featurePath]);
      expect(snapshot.warnings.some((item) => item.includes("未找到 Scenario"))).toBeTrue();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
