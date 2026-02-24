import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const ALLOWED_LAYERS = new Set(["unit", "integration", "browser-cdp", "e2e"]);
export const ALLOWED_CONTRACT_CATEGORIES = new Set(["ux", "protocol", "storage"]);
export type ContractCategory = "ux" | "protocol" | "storage";

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

export interface ParsedProofTarget {
  path: string;
  selector: string;
}

export interface ContractMapping {
  contractId: string;
  proofs: MappingProof[];
}

export interface ContractCategoryMapping {
  contractId: string;
  category: ContractCategory;
}

export interface ContractCategorySnapshot {
  file: string;
  categories: Map<string, ContractCategory>;
}

export interface ValidationSnapshot {
  repoRoot: string;
  contracts: LoadedContract[];
  contractsById: Map<string, LoadedContract>;
  featureRefs: Map<string, string[]>;
  featuresWithoutScenario: string[];
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
  const lines = String(content || "").split(/\r?\n/);
  const tagRegex = /(?:^|\s)@contract\(\s*([^)]+?)\s*\)/g;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("@contract(")) continue;

    tagRegex.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = tagRegex.exec(trimmed))) {
      const id = String(match[1] || "")
        .replace(/['"`]/g, "")
        .replace(/\s+#.*$/, "")
        .trim();
      if (id) refs.add(id);
    }
  }

  return Array.from(refs);
}

export function countScenarios(content: string): number {
  const matches = content.match(/^\s*Scenario(?: Outline)?:/gm);
  return matches?.length || 0;
}

export function isEvidenceJsonTargetPath(targetPath: string): boolean {
  const normalized = String(targetPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return /^bdd\/evidence\/[^/]+\.json$/.test(normalized);
}

export function isFeatureFileTargetPath(targetPath: string): boolean {
  const normalized = String(targetPath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return normalized.endsWith(".feature");
}

function normalizeSelectorText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSelectorTokens(selector: string): string[] {
  return String(selector || "")
    .split("||")
    .map((item) => normalizeSelectorText(item))
    .filter(Boolean);
}

interface EvidenceSelectorCandidate {
  index: number;
  name: string;
  full: string;
}

export function validateEvidenceSelector(
  tests: unknown[],
  selector: string
): { ok: true } | { ok: false; error: string } {
  const tokens = parseSelectorTokens(selector);
  if (tokens.length === 0) return { ok: true };

  const passed: EvidenceSelectorCandidate[] = [];
  const source = Array.isArray(tests) ? tests : [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    const status = normalizeSelectorText(String((item as any)?.status || "")).toLowerCase();
    if (status !== "passed") continue;
    const name = normalizeSelectorText(String((item as any)?.name || ""));
    if (!name) continue;
    const group = normalizeSelectorText(String((item as any)?.group || ""));
    passed.push({
      index: i,
      name,
      full: group ? `${group} :: ${name}` : name
    });
  }

  if (passed.length === 0) {
    return { ok: false, error: "evidence 缺少 passed tests，无法验证 selector" };
  }

  const used = new Set<number>();
  for (const token of tokens) {
    const expectsFull = token.includes("::");
    const candidates = passed.filter((item) => {
      if (used.has(item.index)) return false;
      return expectsFull ? item.full === token : item.name === token;
    });

    if (!expectsFull && candidates.length > 1) {
      return { ok: false, error: `selector "${token}" 命中多个 case，请使用 group :: name 精确匹配` };
    }

    const match = candidates[0];

    if (!match) {
      return { ok: false, error: `evidence 未命中 selector "${token}"` };
    }

    used.add(match.index);
  }

  return { ok: true };
}

export function parseProofTargets(target: string): ParsedProofTarget[] {
  const raw = String(target || "").trim();
  if (!raw) return [];

  const out: ParsedProofTarget[] = [];
  const seen = new Set<string>();
  const pathRegex = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
  const matches = Array.from(raw.matchAll(pathRegex));

  if (matches.length === 0) {
    const [pathPart, ...selectorParts] = raw.split("::");
    const path = String(pathPart || "").trim();
    if (!path) return [];
    const selector = selectorParts.join("::").trim();
    const key = `${path}@@${selector}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ path, selector });
    }
    return out;
  }

  const prefix = raw.slice(0, Number(matches[0]?.index || 0)).trim();
  if (prefix) {
    return [];
  }

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const path = String(current[0] || "").trim();
    if (!path) continue;
    const start = Number(current.index || 0) + path.length;
    const end = typeof next?.index === "number" ? next.index : raw.length;
    const tail = raw.slice(start, end).trim();

    let selector = "";
    if (tail) {
      if (next) {
        if (tail === "+") {
          selector = "";
        } else if (tail.startsWith("::")) {
          const selectorWithDelimiter = tail.slice(2).trim();
          if (!/\+\s*$/.test(selectorWithDelimiter)) {
            return [];
          }
          selector = selectorWithDelimiter.replace(/\+\s*$/, "").trim();
        } else {
          return [];
        }
      } else {
        if (!tail.startsWith("::")) {
          return [];
        }
        selector = tail.slice(2).trim();
      }
    }

    const key = `${path}@@${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, selector });
  }

  return out;
}

export function targetPathFromProof(target: string): string {
  return parseProofTargets(target)[0]?.path || "";
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

async function loadFeatureRefs(
  repoRoot: string,
  warnings: string[],
  errors: string[]
): Promise<{ refs: Map<string, string[]>; featuresWithoutScenario: string[] }> {
  const featuresDir = path.join(repoRoot, "bdd", "features");
  const files = await walkFiles(featuresDir, [".feature"]);
  const refs = new Map<string, string[]>();
  const featuresWithoutScenario: string[] = [];

  if (files.length === 0) {
    errors.push("bdd/features 下没有 .feature 文件");
    return { refs, featuresWithoutScenario };
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
      featuresWithoutScenario.push(relFile);
    }

    for (const id of contractIds) {
      const current = refs.get(id) || [];
      current.push(file);
      refs.set(id, current);
    }
  }

  return { refs, featuresWithoutScenario };
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
  const { refs: featureRefs, featuresWithoutScenario } = await loadFeatureRefs(repoRoot, warnings, errors);
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
    featuresWithoutScenario,
    mappingFile,
    mappings,
    errors,
    warnings
  };
}

export async function loadContractCategories(repoRoot: string, errors: string[] = []): Promise<ContractCategorySnapshot> {
  const file = path.join(repoRoot, "bdd", "mappings", "contract-categories.json");
  const categories = new Map<string, ContractCategory>();

  if (!(await exists(file))) {
    errors.push("缺少 bdd/mappings/contract-categories.json");
    return { file, categories };
  }

  let parsed: unknown;
  try {
    parsed = await readJson<unknown>(file);
  } catch (err) {
    errors.push(`bdd/mappings/contract-categories.json: JSON 解析失败: ${(err as Error).message}`);
    return { file, categories };
  }

  if (!isPlainObject(parsed)) {
    errors.push("bdd/mappings/contract-categories.json: 顶层必须是 object");
    return { file, categories };
  }

  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!isSemver(version)) {
    errors.push("bdd/mappings/contract-categories.json: version 必须是 semver 字符串，如 1.0.0");
  }

  const mappings = Array.isArray(parsed.mappings) ? parsed.mappings : null;
  if (!mappings) {
    errors.push("bdd/mappings/contract-categories.json: 必须包含 mappings 数组");
    return { file, categories };
  }

  for (const item of mappings) {
    if (!isPlainObject(item)) {
      errors.push("bdd/mappings/contract-categories.json: mappings 项必须是 object");
      continue;
    }

    const contractId = typeof item.contractId === "string" ? item.contractId.trim() : "";
    const categoryRaw = typeof item.category === "string" ? item.category.trim() : "";

    if (!contractId) {
      errors.push("bdd/mappings/contract-categories.json: contractId 不能为空");
      continue;
    }
    if (!/^BHV-[A-Z0-9-]+$/.test(contractId)) {
      errors.push(`bdd/mappings/contract-categories.json: contractId 非法: ${contractId}`);
      continue;
    }
    if (!ALLOWED_CONTRACT_CATEGORIES.has(categoryRaw)) {
      errors.push(
        `bdd/mappings/contract-categories.json: contractId=${contractId} category 非法: ${categoryRaw || "<empty>"}`
      );
      continue;
    }

    if (categories.has(contractId)) {
      errors.push(`bdd/mappings/contract-categories.json: contractId 重复: ${contractId}`);
      continue;
    }

    categories.set(contractId, categoryRaw as ContractCategory);
  }

  return { file, categories };
}

export async function fileExistsInRepo(repoRoot: string, repoRelativePath: string): Promise<boolean> {
  const normalized = String(repoRelativePath || "")
    .trim()
    .replace(/^\.\/+/, "");
  if (!normalized || path.isAbsolute(normalized)) {
    return false;
  }

  const rootAbs = path.resolve(repoRoot);
  const abs = path.resolve(rootAbs, normalized);
  const relative = path.relative(rootAbs, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  if (!(await exists(abs))) {
    return false;
  }

  try {
    const [rootReal, targetReal] = await Promise.all([realpath(rootAbs), realpath(abs)]);
    const realRelative = path.relative(rootReal, targetReal);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
