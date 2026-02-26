export interface ToolContract {
  name: string;
}

export interface RegisterToolContractOptions {
  replace?: boolean;
}

const BUILTIN_TOOL_CONTRACTS: ToolContract[] = [
  { name: "read" },
  { name: "write" },
  { name: "edit" },
  { name: "bash" }
];

const builtinContracts = new Map<string, ToolContract>();
const overrideContracts = new Map<string, ToolContract>();

function normalizeName(input: unknown): string {
  return String(input || "").trim();
}

function validateContract(contract: ToolContract): ToolContract {
  const canonicalName = normalizeName(contract.name);
  if (!canonicalName) throw new Error("tool contract name 不能为空");
  return {
    name: canonicalName
  };
}

for (const contract of BUILTIN_TOOL_CONTRACTS) {
  const normalized = validateContract(contract);
  builtinContracts.set(normalized.name, normalized);
}

export function registerToolContract(contract: ToolContract, options: RegisterToolContractOptions = {}): void {
  const normalized = validateContract(contract);
  const existing = overrideContracts.has(normalized.name) || builtinContracts.has(normalized.name);
  if (existing && !options.replace) {
    throw new Error(`tool contract already registered: ${normalized.name}`);
  }

  overrideContracts.set(normalized.name, normalized);
}

export function unregisterToolContract(name: string): boolean {
  const canonicalName = normalizeName(name);
  if (!canonicalName) return false;
  return overrideContracts.delete(canonicalName);
}

export function resolveToolName(tool: string): string | null {
  const requested = normalizeName(tool);
  if (!requested) return null;

  if (overrideContracts.has(requested)) return requested;
  if (builtinContracts.has(requested)) return requested;
  return null;
}

export function isSupportedToolName(tool: string): boolean {
  return resolveToolName(tool) !== null;
}

export function listToolContracts(): Array<{ name: string; source: "builtin" | "override" }> {
  const out: Array<{ name: string; source: "builtin" | "override" }> = [];
  for (const [name, builtin] of builtinContracts.entries()) {
    const resolved = overrideContracts.get(name) || builtin;
    out.push({
      name: resolved.name,
      source: overrideContracts.has(name) ? "override" : "builtin"
    });
  }
  for (const [name, override] of overrideContracts.entries()) {
    if (builtinContracts.has(name)) continue;
    out.push({
      name: override.name,
      source: "override"
    });
  }
  return out;
}
