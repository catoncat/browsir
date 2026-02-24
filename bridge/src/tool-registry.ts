export interface ToolContract {
  name: string;
  aliases?: string[];
}

export interface RegisterToolContractOptions {
  replace?: boolean;
}

const BUILTIN_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: "read",
    aliases: ["read_file", "fs.read_text", "fs.read"]
  },
  {
    name: "write",
    aliases: ["write_file", "fs.write_text", "fs.write"]
  },
  {
    name: "edit",
    aliases: ["edit_file", "fs.patch_text", "fs.edit"]
  },
  {
    name: "bash",
    aliases: ["command.run", "process.exec"]
  }
];

const builtinContracts = new Map<string, ToolContract>();
const overrideContracts = new Map<string, ToolContract>();
const builtinAliasToCanonical = new Map<string, string>();
const overrideAliasToCanonical = new Map<string, string>();

function normalizeName(input: unknown): string {
  return String(input || "").trim();
}

function normalizeAliases(aliases: unknown, canonicalName: string): string[] {
  if (!Array.isArray(aliases)) return [];
  return aliases
    .map((item) => normalizeName(item))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index && item !== canonicalName);
}

function setAliasMappings(target: Map<string, string>, canonicalName: string, aliases: string[]): void {
  for (const alias of aliases) {
    target.set(alias, canonicalName);
  }
}

function clearAliasMappings(target: Map<string, string>, canonicalName: string): void {
  for (const [alias, canonical] of target.entries()) {
    if (canonical === canonicalName) {
      target.delete(alias);
    }
  }
}

function validateContract(contract: ToolContract): ToolContract {
  const canonicalName = normalizeName(contract.name);
  if (!canonicalName) throw new Error("tool contract name 不能为空");
  const aliases = normalizeAliases(contract.aliases, canonicalName);
  return {
    name: canonicalName,
    aliases
  };
}

for (const contract of BUILTIN_TOOL_CONTRACTS) {
  const normalized = validateContract(contract);
  builtinContracts.set(normalized.name, normalized);
  setAliasMappings(builtinAliasToCanonical, normalized.name, normalized.aliases || []);
}

export function registerToolContract(contract: ToolContract, options: RegisterToolContractOptions = {}): void {
  const normalized = validateContract(contract);
  const existing = overrideContracts.has(normalized.name) || builtinContracts.has(normalized.name);
  if (existing && !options.replace) {
    throw new Error(`tool contract already registered: ${normalized.name}`);
  }

  clearAliasMappings(overrideAliasToCanonical, normalized.name);
  overrideContracts.set(normalized.name, normalized);
  setAliasMappings(overrideAliasToCanonical, normalized.name, normalized.aliases || []);
}

export function unregisterToolContract(name: string): boolean {
  const canonicalName = normalizeName(name);
  if (!canonicalName) return false;
  const existed = overrideContracts.delete(canonicalName);
  clearAliasMappings(overrideAliasToCanonical, canonicalName);
  return existed;
}

export function resolveToolName(tool: string): string | null {
  const requested = normalizeName(tool);
  if (!requested) return null;

  if (overrideContracts.has(requested)) return requested;
  if (builtinContracts.has(requested)) return requested;

  const overrideAliasMatch = overrideAliasToCanonical.get(requested);
  if (overrideAliasMatch) return overrideAliasMatch;

  const builtinAliasMatch = builtinAliasToCanonical.get(requested);
  if (!builtinAliasMatch) return null;
  if (overrideContracts.has(builtinAliasMatch)) return builtinAliasMatch;
  return builtinAliasMatch;
}

export function isSupportedToolName(tool: string): boolean {
  return resolveToolName(tool) !== null;
}

export function listToolContracts(): Array<{ name: string; aliases: string[]; source: "builtin" | "override" }> {
  const out: Array<{ name: string; aliases: string[]; source: "builtin" | "override" }> = [];
  for (const [name, builtin] of builtinContracts.entries()) {
    const resolved = overrideContracts.get(name) || builtin;
    out.push({
      name: resolved.name,
      aliases: [...(resolved.aliases || [])],
      source: overrideContracts.has(name) ? "override" : "builtin"
    });
  }
  for (const [name, override] of overrideContracts.entries()) {
    if (builtinContracts.has(name)) continue;
    out.push({
      name: override.name,
      aliases: [...(override.aliases || [])],
      source: "override"
    });
  }
  return out;
}

