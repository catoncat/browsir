import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileExistsInRepo, runStructuralValidation, targetPathFromProof } from "./bdd-lib";

async function validateEvidence(repoRoot: string, target: string): Promise<string | null> {
  const normalized = path.normalize(target);
  const evidencePrefix = path.normalize("bdd/evidence/");

  if (!normalized.startsWith(evidencePrefix) || path.extname(normalized) !== ".json") {
    return null;
  }

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

  return null;
}

function normalizeProfile(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  return raw || "default";
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
  const snapshot = await runStructuralValidation(repoRoot);
  const gateErrors = [...snapshot.errors];
  let checkedContracts = 0;

  const mappingByContractId = new Map(snapshot.mappings.map((item) => [item.contractId, item]));

  for (const loaded of snapshot.contracts) {
    const contract = loaded.contract;
    if (!shouldCheckContract(contract, gateProfile)) {
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
      const target = targetPathFromProof(proof.target);
      if (!target) {
        gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} target 为空`);
        continue;
      }

      const exists = await fileExistsInRepo(repoRoot, target);
      if (!exists) {
        gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} target 不存在: ${target}`);
        continue;
      }

      if (proof.layer === "e2e") {
        const evidenceError = await validateEvidence(repoRoot, target);
        if (evidenceError) {
          gateErrors.push(`gate: contract ${contract.id} layer=${proof.layer} ${evidenceError}`);
        }
      }

      if (proof.layer === "browser-cdp" && path.extname(target) === ".feature") {
        const refs = snapshot.featureRefs.get(contract.id) || [];
        const normalized = refs.map((x) => path.normalize(path.relative(repoRoot, x)));
        if (!normalized.includes(path.normalize(target))) {
          gateErrors.push(`gate: contract ${contract.id} 的 feature 映射未包含 target: ${target}`);
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
  console.log(`  contracts: ${checkedContracts}/${snapshot.contracts.length}`);
  console.log(`  mappings: ${snapshot.mappings.length}`);
}

main().catch((err) => {
  console.error(`[bdd:gate] unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
