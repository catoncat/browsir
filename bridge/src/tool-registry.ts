export interface ToolContract {
  name: string;
  aliases?: string[];
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

const canonicalToAliases = new Map<string, string[]>();
const aliasToCanonical = new Map<string, string>();

for (const contract of BUILTIN_TOOL_CONTRACTS) {
  const canonical = String(contract.name || "").trim();
  if (!canonical) continue;
  const aliases = Array.isArray(contract.aliases)
    ? contract.aliases
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index && item !== canonical)
    : [];
  canonicalToAliases.set(canonical, aliases);
  for (const alias of aliases) {
    aliasToCanonical.set(alias, canonical);
  }
}

export function resolveToolName(tool: string): string | null {
  const requested = String(tool || "").trim();
  if (!requested) return null;
  if (canonicalToAliases.has(requested)) return requested;
  return aliasToCanonical.get(requested) || null;
}

export function isSupportedToolName(tool: string): boolean {
  return resolveToolName(tool) !== null;
}

export function listToolContracts(): Array<{ name: string; aliases: string[] }> {
  return Array.from(canonicalToAliases.entries()).map(([name, aliases]) => ({
    name,
    aliases: [...aliases]
  }));
}

