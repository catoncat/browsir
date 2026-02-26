import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  ALLOWED_CONTRACT_CATEGORIES,
  fileExistsInRepo,
  isEvidenceJsonTargetPath,
  isFeatureFileTargetPath,
  loadContractCategories,
  parseProofTargets,
  runStructuralValidation,
  validateEvidenceSelector,
  type ContractCategory
} from "./bdd-lib";

async function validateEvidence(repoRoot: string, targetPath: string, selector: string): Promise<string | null> {
  if (!isEvidenceJsonTargetPath(targetPath)) {
    return `e2e target 非法，必须是 bdd/evidence/*.json: ${targetPath}`;
  }

  const normalized = path.normalize(targetPath);
  const abs = path.join(repoRoot, normalized);

  let parsed: any;
  try {
    const raw = await readFile(abs, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    return `evidence 解析失败: ${normalized}: ${(err as Error).message}`;
  }

  if (parsed?.passed !== true) {
    return `evidence 未通过: ${normalized} (expected passed=true)`;
  }

  const tests = Array.isArray(parsed?.tests) ? parsed.tests : [];
  const result = validateEvidenceSelector(tests, selector);
  if (!result.ok) {
    return `${result.error}: ${normalized}`;
  }

  return null;
}

function normalizeProfile(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  return raw || "default";
}

function normalizeCategory(value: unknown): "all" | ContractCategory {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "all") return "all";
  if (ALLOWED_CONTRACT_CATEGORIES.has(raw)) {
    return raw as ContractCategory;
  }
  throw new Error(`BDD_GATE_CATEGORY 非法: ${raw}（允许: all|ux|protocol|storage）`);
}

function normalizeInlineText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSelectorTokens(selector: string): string[] {
  return String(selector || "")
    .split("||")
    .flatMap((chunk) => chunk.split(/\s\+\s/))
    .map((item) => normalizeInlineText(item))
    .filter(Boolean);
}

function isTestSourcePath(targetPath: string): boolean {
  const normalized = String(targetPath || "").replace(/\\/g, "/");
  return normalized.includes("/__tests__/") || /\.test\.[cm]?[jt]sx?$/.test(normalized) || /\.spec\.[cm]?[jt]sx?$/.test(normalized);
}

function extractStructuredSelectorTerms(selectorToken: string): string[] {
  const token = normalizeInlineText(selectorToken);
  if (!token) return [];
  if (!/[._()|:-]/.test(token)) return [];

  const rawTerms = token.match(/[A-Za-z_][A-Za-z0-9_.-]*/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTerms) {
    const term = raw.trim();
    if (!term) continue;
    const looksCodeLike = term.includes(".") || term.includes("_") || /[A-Z]/.test(term);
    if (!looksCodeLike) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function validateUnitIntegrationSelector(
  sourceText: string,
  selector: string,
  targetPath: string
): string | null {
  const tokens = parseSelectorTokens(selector);
  if (tokens.length === 0) return null;

  const normalizedSource = normalizeInlineText(sourceText);
  const testSource = isTestSourcePath(targetPath);

  for (const token of tokens) {
    const normalizedToken = normalizeInlineText(token);
    if (!normalizedToken) continue;
    if (normalizedSource.includes(normalizedToken)) continue;

    const structuredTerms = extractStructuredSelectorTerms(normalizedToken);
    if (structuredTerms.length === 0) {
      if (testSource) {
        return `unit/integration selector 未命中 "${normalizedToken}"`;
      }
      continue;
    }

    const missing = structuredTerms.filter((term) => !normalizedSource.includes(term));
    if (missing.length > 0) {
      return `unit/integration selector 未命中 "${normalizedToken}" (missing: ${missing.join(", ")})`;
    }
  }

  return null;
}

function shouldCheckContract(contract: any, gateProfile: string): boolean {
  const ctx = contract?.context;
  const profileField = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>).gate_profile : null;

  if (typeof profileField === "string") {
    const profiles = profileField
      .split(",")
      .map((item) => normalizeProfile(item))
      .filter(Boolean);
    if (profiles.length === 0) return true;
    return profiles.includes(gateProfile);
  }

  if (Array.isArray(profileField)) {
    const profiles = profileField.map((item) => normalizeProfile(item)).filter(Boolean);
    if (profiles.length === 0) return true;
    return profiles.includes(gateProfile);
  }

  return true;
}

async function main() {
  const repoRoot = process.cwd();
  const gateProfile = normalizeProfile(process.env.BDD_GATE_PROFILE);
  const gateCategory = normalizeCategory(process.env.BDD_GATE_CATEGORY);
  const snapshot = await runStructuralValidation(repoRoot);
  const gateErrors = [...snapshot.errors];
  const sourceTextCache = new Map<string, string>();
  const categories = await loadContractCategories(repoRoot, gateErrors);
  let checkedContracts = 0;

  const mappingByContractId = new Map(snapshot.mappings.map((item) => [item.contractId, item]));

  for (const feature of snapshot.featuresWithoutScenario) {
    gateErrors.push(`gate: feature 缺少 Scenario，不允许进入门禁绿灯: ${feature}`);
  }

  for (const loaded of snapshot.contracts) {
    if (!categories.categories.has(loaded.contract.id)) {
      gateErrors.push(`gate: contract ${loaded.contract.id} 缺少 category 映射`);
    }
  }
  for (const contractId of categories.categories.keys()) {
    if (!snapshot.contractsById.has(contractId)) {
      gateErrors.push(`gate: category 映射指向不存在的 contract: ${contractId}`);
    }
  }

  for (const loaded of snapshot.contracts) {
    const contract = loaded.contract;
    if (!shouldCheckContract(contract, gateProfile)) {
      continue;
    }
    const contractCategory = categories.categories.get(contract.id);
    if (!contractCategory) {
      continue;
    }
    if (gateCategory !== "all" && contractCategory !== gateCategory) {
      continue;
    }
    checkedContracts += 1;
    const mapping = mappingByContractId.get(contract.id);

    if (!mapping) {
      gateErrors.push(`gate: contract ${contract.id} 缺少 mapping`);
      continue;
    }

    if (mapping.proofs.length === 0) {
      gateErrors.push(`gate: contract ${contract.id} mapping.proofs 不能为空`);
      continue;
    }

    const proofLayers = new Set(mapping.proofs.map((proof) => proof.layer));

    for (const requiredLayer of contract.proof_requirements.required_layers) {
      if (!proofLayers.has(requiredLayer)) {
        gateErrors.push(`gate: contract ${contract.id} 缺少 required layer: ${requiredLayer}`);
      }
    }

    if (proofLayers.size < contract.proof_requirements.min_layers) {
      gateErrors.push(
        `gate: contract ${contract.id} 实际证明层数(${proofLayers.size}) < min_layers(${contract.proof_requirements.min_layers})`
      );
    }

    if ((contract.risk === "high" || contract.risk === "critical") && contract.proof_requirements.min_layers < 2) {
      gateErrors.push(
        `gate: contract ${contract.id} 风险=${contract.risk} 但 min_layers=${contract.proof_requirements.min_layers}，必须 >= 2`
      );
    }

    for (const proof of mapping.proofs) {
      const targets = parseProofTargets(proof.target);
      if (targets.length === 0) {
        gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} target 为空`);
        continue;
      }

      for (const targetItem of targets) {
        const target = targetItem.path;

        if (proof.layer === "browser-cdp" && !isFeatureFileTargetPath(target)) {
          gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} target 必须是 .feature: ${target}`);
          continue;
        }

        const exists = await fileExistsInRepo(repoRoot, target);
        if (!exists) {
          gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} target 不存在: ${target}`);
          continue;
        }

        if (proof.layer === "e2e") {
          const evidenceError = await validateEvidence(repoRoot, target, targetItem.selector);
          if (evidenceError) {
            gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} ${evidenceError}`);
          }
        }

        if (proof.layer === "unit" || proof.layer === "integration") {
          const selector = String(targetItem.selector || "").trim();
          if (selector) {
            const normalizedTarget = path.normalize(target);
            let sourceText = sourceTextCache.get(normalizedTarget);
            if (sourceText == null) {
              try {
                sourceText = await readFile(path.join(repoRoot, normalizedTarget), "utf8");
              } catch {
                sourceText = "";
              }
              sourceTextCache.set(normalizedTarget, sourceText);
            }
            const selectorError = validateUnitIntegrationSelector(sourceText, selector, normalizedTarget);
            if (selectorError) {
              gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} ${selectorError}: ${target}`);
            }
          }
        }

        if (proof.layer === "browser-cdp") {
          const refs = snapshot.featureRefs.get(contract.id) || [];
          const normalized = refs.map((x) => path.normalize(path.relative(repoRoot, x)));
          if (!normalized.includes(path.normalize(target))) {
            gateErrors.push(`gate: contract ${contract.id} 的 feature 映射未包含 target: ${target}`);
          }
        }
      }
    }
  }

  if (gateErrors.length > 0) {
    console.error("[bdd:gate] failed:");
    for (const error of gateErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("[bdd:gate] ok");
  console.log(`  profile: ${gateProfile}`);
  console.log(`  category: ${gateCategory}`);
  console.log(`  contracts: ${checkedContracts}/${snapshot.contracts.length}`);
  console.log(`  mappings: ${snapshot.mappings.length}`);
}

main().catch((err) => {
  console.error(`[bdd:gate] unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
