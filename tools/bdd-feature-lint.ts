import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  loadContractCategories,
  rel,
  runStructuralValidation,
  walkFiles,
  type ContractCategory
} from "./bdd-lib";

interface ForbiddenPattern {
  name: string;
  re: RegExp;
}

interface MatchHit {
  line: number;
  token: string;
}

export interface FeatureLintResult {
  errors: string[];
  counts: {
    features: number;
    business: number;
    technical: number;
  };
}

const BUSINESS_PREFIX = path.normalize("bdd/features/business/");
const TECHNICAL_PREFIX = path.normalize("bdd/features/technical/");

const BUSINESS_FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  { name: "internal-architecture", re: /\b(orchestrator|kernel|runtime-loop|runtime-router|adapter)\b/gi },
  { name: "capability-routing", re: /\b(capability provider|capability-provider|tool provider|tool-provider)\b/gi },
  { name: "internal-runtime-call", re: /\bbrain\.step\.execute\b/gi },
  { name: "protocol-cdp", re: /\bcdp\.(snapshot|action|verify|observe|execute|detach)\b/gi },
  { name: "protocol-lease", re: /\blease\.(acquire|release)\b/gi },
  { name: "protocol-fields", re: /\b(sessionId|parentSessionId|agentId|backendNodeId|maxTokens)\b/g },
  { name: "locator-aria", re: /\baria-[a-z-]+\b/gi },
  { name: "locator-testid", re: /\bdata-testid\b/gi },
  { name: "locator-api", re: /\b(getByRole|getByText|locator)\s*\(/gi },
  { name: "locator-specific", re: /\b(xpath|css selector|nth=\d+|ref=\w+)\b/gi },
  { name: "test-artifact-evidence", re: /\bbdd\/evidence\b|\bbrain-e2e(-live)?\.latest\.json\b/gi },
  { name: "test-artifact-mapping", re: /\bcontract-to-tests\.json\b|\bcontract-categories\.json\b/gi },
  { name: "assertion-code", re: /\bexpect\(|\bassert\b/gi }
];

function expectedPrefixForCategory(category: ContractCategory): string {
  if (category === "ux") return BUSINESS_PREFIX;
  return TECHNICAL_PREFIX;
}

function normalizeRelPath(repoRoot: string, file: string): string {
  return path.normalize(path.relative(repoRoot, file));
}

function isBusinessFeature(relativeFile: string): boolean {
  return path.normalize(relativeFile).startsWith(BUSINESS_PREFIX);
}

function isTechnicalFeature(relativeFile: string): boolean {
  return path.normalize(relativeFile).startsWith(TECHNICAL_PREFIX);
}

function findMatches(text: string, pattern: RegExp, limit = 3): MatchHit[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const matches: MatchHit[] = [];

  let hit: RegExpExecArray | null = null;
  while ((hit = re.exec(text)) && matches.length < limit) {
    const index = typeof hit.index === "number" ? hit.index : 0;
    const line = text.slice(0, index).split("\n").length;
    const token = String(hit[0] || "").trim();
    matches.push({ line, token });

    if (hit.index === re.lastIndex) {
      re.lastIndex += 1;
    }
  }

  return matches;
}

async function lintFeatureLayering(repoRoot: string, errors: string[]) {
  const featuresDir = path.join(repoRoot, "bdd", "features");
  const featureFiles = await walkFiles(featuresDir, [".feature"]);

  if (featureFiles.length === 0) {
    errors.push("bdd/features 下没有 .feature 文件");
    return;
  }

  for (const file of featureFiles) {
    const relFile = normalizeRelPath(repoRoot, file);
    if (!isBusinessFeature(relFile) && !isTechnicalFeature(relFile)) {
      errors.push(`${relFile}: feature 必须放在 bdd/features/business/** 或 bdd/features/technical/**`);
    }
  }
}

async function lintCategoryToFeatureLayer(repoRoot: string, errors: string[]) {
  const snapshot = await runStructuralValidation(repoRoot);
  errors.push(...snapshot.errors);
  const categories = await loadContractCategories(repoRoot, errors);

  for (const [contractId, files] of snapshot.featureRefs.entries()) {
    const category = categories.categories.get(contractId);
    if (!category) continue;

    const expectedPrefix = expectedPrefixForCategory(category);
    for (const file of files) {
      const relFile = normalizeRelPath(repoRoot, file);
      if (!path.normalize(relFile).startsWith(expectedPrefix)) {
        const expectedLayer = category === "ux" ? "business" : "technical";
        errors.push(
          `contract ${contractId} category=${category} 的 feature 必须位于 ${expectedLayer} 层: ${relFile}`
        );
      }
    }
  }
}

async function lintBusinessFeatureContent(repoRoot: string, errors: string[]) {
  const businessDir = path.join(repoRoot, "bdd", "features", "business");
  const featureFiles = await walkFiles(businessDir, [".feature"]);

  for (const file of featureFiles) {
    const relFile = normalizeRelPath(repoRoot, file);
    const text = await readFile(file, "utf8");

    for (const pattern of BUSINESS_FORBIDDEN_PATTERNS) {
      const hits = findMatches(text, pattern.re, 3);
      for (const hit of hits) {
        errors.push(
          `${relFile}:${hit.line}: business feature 命中实现细节词 "${hit.token}" [${pattern.name}]`
        );
      }
    }
  }
}

export async function runBddFeatureLint(repoRoot: string): Promise<FeatureLintResult> {
  const errors: string[] = [];

  await lintFeatureLayering(repoRoot, errors);
  await lintCategoryToFeatureLayer(repoRoot, errors);
  await lintBusinessFeatureContent(repoRoot, errors);

  const allFeatures = await walkFiles(path.join(repoRoot, "bdd", "features"), [".feature"]);
  const businessFeatures = allFeatures.filter((file) =>
    path.normalize(rel(repoRoot, file)).startsWith(BUSINESS_PREFIX)
  );
  const technicalFeatures = allFeatures.filter((file) =>
    path.normalize(rel(repoRoot, file)).startsWith(TECHNICAL_PREFIX)
  );

  return {
    errors,
    counts: {
      features: allFeatures.length,
      business: businessFeatures.length,
      technical: technicalFeatures.length
    }
  };
}

async function main() {
  const repoRoot = process.cwd();
  const result = await runBddFeatureLint(repoRoot);

  if (result.errors.length > 0) {
    console.error("[bdd:lint:features] failed:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log("[bdd:lint:features] ok");
  console.log(`  features: ${result.counts.features}`);
  console.log(`  business: ${result.counts.business}`);
  console.log(`  technical: ${result.counts.technical}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[bdd:lint:features] unexpected error: ${(err as Error).message}`);
    process.exit(1);
  });
}
