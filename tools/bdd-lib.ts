import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_LAYERS = new Set(["unit", "integration", "browser-cdp", "e2e"]);

export interface BehaviorContract {
  id: string;
  intent: string;
  context: Record<string, unknown>;
  steps: string[];
  observables: string[];
  risk: "low" | "medium" | "high" | "critical";
  allowed_side_effects: string[];
  proof_requirements: {
    required_layers: Array<"unit" | "integration" | "browser-cdp" | "e2e">;
    min_layers: number;
  };
  degrade_policy: Record<string, unknown>;
  rollback_or_compensation?: string[];
  version: string;
}

export interface LoadedContract {
  file: string;
  contract: BehaviorContract;
}

export interface MappingProof {
  layer: "unit" | "integration" | "browser-cdp" | "e2e";
  target: string;
}

export interface ContractMapping {
  contractId: string;
  proofs: MappingProof[];
}

export interface ValidationSnapshot {
  repoRoot: string;
  contracts: LoadedContract[];
  contractsById: Map<string, LoadedContract>;
  featureRefs: Map<string, string[]>;
  mappingFile: string;
  mappings: ContractMapping[];
  errors: string[];
  warnings: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function rel(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file) || ".";
}

export async function walkFiles(dir: string, suffixes: string[]): Promise<string[]> {
  const out: string[] = [];

  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
        continue;
      }

      if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        out.push(abs);
      }
    }
  }

  if (await exists(dir)) {
    await visit(dir);
  }
  return out;
}

async function readJson<T>(file: string): Promise<T> {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSemver(value: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value);
}

export function parseFeatureContractRefs(content: string): string[] {
  const refs = new Set<string>();
  const re = /@contract\(([^)]+)\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = re.exec(content))) {
    const id = String(match[1] || "")
      .replace(/['"`]/g, "")
      .trim();
    if (id) refs.add(id);
  }

  return Array.from(refs);
}

export function countScenarios(content: string): number {
  const matches = content.match(/^\s*Scenario(?: Outline)?:/gm);
  return matches?.length || 0;
}

export function targetPathFromProof(target: string): string {
  return String(target || "").split("::")[0].trim();
}

function validateContractShape(contract: unknown, file: string, errors: string[]) {
  const mark = (msg: string) => errors.push(`${file}: ${msg}`);

  if (!isPlainObject(contract)) {
    mark("contract 必须是 JSON object");
    return;
  }

  const id = contract.id;
  if (typeof id !== "string" || !/^BHV-[A-Z0-9-]+$/.test(id)) {
    mark("id 必须匹配 ^BHV-[A-Z0-9-]+$");
  }

  if (typeof contract.intent !== "string" || !contract.intent.trim()) {
    mark("intent 不能为空字符串");
  }

  if (!isPlainObject(contract.context) || Object.keys(contract.context).length === 0) {
    mark("context 必须是非空 object");
  }

  if (!Array.isArray(contract.steps) || contract.steps.length === 0 || contract.steps.some((x) => typeof x !== "string")) {
    mark("steps 必须是非空字符串数组");
  }

  if (
    !Array.isArray(contract.observables) ||
    contract.observables.length === 0 ||
    contract.observables.some((x) => typeof x !== "string")
  ) {
    mark("observables 必须是非空字符串数组");
  }

  if (!new Set(["low", "medium", "high", "critical"]).has(String(contract.risk || ""))) {
    mark("risk 必须是 low|medium|high|critical");
  }

  if (
    !Array.isArray(contract.allowed_side_effects) ||
    contract.allowed_side_effects.length === 0 ||
    contract.allowed_side_effects.some((x) => typeof x !== "string")
  ) {
    mark("allowed_side_effects 必须是非空字符串数组");
  }

  const pr = contract.proof_requirements;
  if (!isPlainObject(pr)) {
    mark("proof_requirements 必须是 object");
  } else {
    const layers = pr.required_layers;
    const minLayers = pr.min_layers;

    if (!Array.isArray(layers) || layers.length === 0) {
      mark("proof_requirements.required_layers 必须是非空数组");
    } else {
      for (const layer of layers) {
        if (!ALLOWED_LAYERS.has(String(layer))) {
          mark(`proof_requirements.required_layers 包含未知层: ${String(layer)}`);
        }
      }
    }

    if (!Number.isInteger(minLayers) || Number(minLayers) < 1) {
      mark("proof_requirements.min_layers 必须是 >=1 的整数");
    }

    if (Array.isArray(layers) && Number.isInteger(minLayers) && Number(minLayers) > layers.length) {
      mark("proof_requirements.min_layers 不能大于 required_layers 数量");
    }
  }

  if (!isPlainObject(contract.degrade_policy) || Object.keys(contract.degrade_policy).length === 0) {
    mark("degrade_policy 必须是非空 object");
  }

  if (contract.rollback_or_compensation !== undefined) {
    if (
      !Array.isArray(contract.rollback_or_compensation) ||
      contract.rollback_or_compensation.some((x) => typeof x !== "string")
    ) {
      mark("rollback_or_compensation 必须是字符串数组");
    }
  }

  if (typeof contract.version !== "string" || !isSemver(contract.version)) {
    mark("version 必须是 semver 字符串，如 1.0.0");
  }
}

async function loadContracts(repoRoot: string, errors: string[]): Promise<{ contracts: LoadedContract[]; byId: Map<string, LoadedContract> }> {
  const contractsDir = path.join(repoRoot, "bdd", "contracts");
  const files = await walkFiles(contractsDir, [".json"]);
  const contracts: LoadedContract[] = [];
  const byId = new Map<string, LoadedContract>();

  if (files.length === 0) {
    errors.push("bdd/contracts 下没有 contract json 文件");
    return { contracts, byId };
  }

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = await readJson<unknown>(file);
    } catch (err) {
      errors.push(`${rel(repoRoot, file)}: JSON 解析失败: ${(err as Error).message}`);
      continue;
    }

    validateContractShape(parsed, rel(repoRoot, file), errors);
    if (!isPlainObject(parsed) || typeof parsed.id !== "string") continue;

    const loaded: LoadedContract = {
      file,
      contract: parsed as BehaviorContract
    };

    if (byId.has(loaded.contract.id)) {
      const previous = byId.get(loaded.contract.id)!;
      errors.push(
        `contract id 重复: ${loaded.contract.id} -> ${rel(repoRoot, previous.file)} 和 ${rel(repoRoot, file)}`
      );
      continue;
    }

    byId.set(loaded.contract.id, loaded);
    contracts.push(loaded);
  }

  return { contracts, byId };
}

async function loadFeatureRefs(repoRoot: string, warnings: string[], errors: string[]): Promise<Map<string, string[]>> {
  const featuresDir = path.join(repoRoot, "bdd", "features");
  const files = await walkFiles(featuresDir, [".feature"]);
  const refs = new Map<string, string[]>();

  if (files.length === 0) {
    errors.push("bdd/features 下没有 .feature 文件");
    return refs;
  }

  for (const file of files) {
    const relFile = rel(repoRoot, file);
    const text = await readFile(file, "utf8");
    const contractIds = parseFeatureContractRefs(text);

    if (contractIds.length === 0) {
      warnings.push(`${relFile}: 未找到 @contract(...) 标记`);
    }

    const scenarios = countScenarios(text);
    if (scenarios === 0) {
      warnings.push(`${relFile}: 未找到 Scenario`);
    }

    for (const id of contractIds) {
      const current = refs.get(id) || [];
      current.push(file);
      refs.set(id, current);
    }
  }

  return refs;
}

async function loadMappings(repoRoot: string, errors: string[]): Promise<{ file: string; mappings: ContractMapping[] }> {
  const file = path.join(repoRoot, "bdd", "mappings", "contract-to-tests.json");
  if (!(await exists(file))) {
    errors.push("缺少 bdd/mappings/contract-to-tests.json");
    return { file, mappings: [] };
  }

  let parsed: unknown;
  try {
    parsed = await readJson<unknown>(file);
  } catch (err) {
    errors.push(`bdd/mappings/contract-to-tests.json: JSON 解析失败: ${(err as Error).message}`);
    return { file, mappings: [] };
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.mappings)) {
    errors.push("bdd/mappings/contract-to-tests.json: 必须包含 mappings 数组");
    return { file, mappings: [] };
  }

  const mappings: ContractMapping[] = [];
  for (const item of parsed.mappings) {
    if (!isPlainObject(item)) {
      errors.push("bdd/mappings/contract-to-tests.json: mappings 项必须是 object");
      continue;
    }

    const contractId = typeof item.contractId === "string" ? item.contractId.trim() : "";
    const proofs = Array.isArray(item.proofs) ? item.proofs : [];

    if (!contractId) {
      errors.push("bdd/mappings/contract-to-tests.json: contractId 不能为空");
      continue;
    }

    const outProofs: MappingProof[] = [];
    for (const proof of proofs) {
      if (!isPlainObject(proof)) {
        errors.push(`mapping(${contractId}) proof 必须是 object`);
        continue;
      }

      const layer = typeof proof.layer === "string" ? proof.layer.trim() : "";
      const target = typeof proof.target === "string" ? proof.target.trim() : "";

      if (!ALLOWED_LAYERS.has(layer)) {
        errors.push(`mapping(${contractId}) 包含未知 layer: ${layer || "<empty>"}`);
        continue;
      }

      if (!target) {
        errors.push(`mapping(${contractId}) layer=${layer} 的 target 不能为空`);
        continue;
      }

      outProofs.push({ layer: layer as MappingProof["layer"], target });
    }

    mappings.push({ contractId, proofs: outProofs });
  }

  return { file, mappings };
}

export async function runStructuralValidation(repoRoot: string): Promise<ValidationSnapshot> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schemaFile = path.join(repoRoot, "bdd", "schemas", "behavior-contract.schema.json");
  if (!(await exists(schemaFile))) {
    errors.push("缺少 bdd/schemas/behavior-contract.schema.json");
  } else {
    try {
      await readJson<unknown>(schemaFile);
    } catch (err) {
      errors.push(`bdd/schemas/behavior-contract.schema.json: JSON 解析失败: ${(err as Error).message}`);
    }
  }

  const { contracts, byId } = await loadContracts(repoRoot, errors);
  const featureRefs = await loadFeatureRefs(repoRoot, warnings, errors);
  const { file: mappingFile, mappings } = await loadMappings(repoRoot, errors);

  for (const contract of contracts) {
    if (!featureRefs.has(contract.contract.id)) {
      errors.push(`contract ${contract.contract.id} 未在任何 feature 使用 @contract(...) 引用`);
    }
  }

  for (const [contractId, files] of featureRefs.entries()) {
    if (!byId.has(contractId)) {
      errors.push(
        `feature 引用了不存在的 contract: ${contractId} -> ${files.map((x) => rel(repoRoot, x)).join(", ")}`
      );
    }
  }

  const mappingIdSeen = new Set<string>();
  for (const mapping of mappings) {
    if (mappingIdSeen.has(mapping.contractId)) {
      errors.push(`mapping contractId 重复: ${mapping.contractId}`);
      continue;
    }
    mappingIdSeen.add(mapping.contractId);

    if (!byId.has(mapping.contractId)) {
      errors.push(
        `mapping(${mapping.contractId}) 指向不存在的 contract (文件: ${rel(repoRoot, mappingFile)})`
      );
    }
  }

  return {
    repoRoot,
    contracts,
    contractsById: byId,
    featureRefs,
    mappingFile,
    mappings,
    errors,
    warnings
  };
}

export async function fileExistsInRepo(repoRoot: string, repoRelativePath: string): Promise<boolean> {
  const normalized = repoRelativePath.replace(/^\.\//, "");
  const abs = path.join(repoRoot, normalized);
  return exists(abs);
}
