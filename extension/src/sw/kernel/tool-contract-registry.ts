type JsonRecord = Record<string, unknown>;

export interface ToolContract {
  name: string;
  description: string;
  parameters: JsonRecord;
  aliases?: string[];
}

export interface RegisterToolContractOptions {
  replace?: boolean;
}

export interface ToolContractView {
  name: string;
  description: string;
  aliases: string[];
  source: "builtin" | "override";
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonRecord;
  };
}

const DEFAULT_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: "bash",
    description: "Execute a shell command via bash.exec.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: {
          type: "number",
          description: "Optional command timeout in milliseconds. For long tasks, increase this value."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description: "Read a file's content",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append", "create"] }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description: "Apply edits to a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old: { type: "string" },
              new: { type: "string" }
            },
            required: ["old", "new"]
          }
        }
      },
      required: ["path", "edits"]
    }
  },
  {
    name: "snapshot",
    description: "Take an accessibility-first snapshot of the current browser tab",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        mode: { type: "string", enum: ["text", "interactive", "full"] },
        selector: { type: "string" },
        filter: { type: "string", enum: ["interactive", "all"] },
        format: { type: "string", enum: ["compact", "json"] },
        diff: { type: "boolean" },
        maxTokens: { type: "number" },
        depth: { type: "number" },
        noAnimations: { type: "boolean" }
      },
      required: []
    }
  },
  {
    name: "browser_action",
    description: "Perform a browser action (click, type, fill, press, scroll, select, navigate)",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        kind: { type: "string", enum: ["click", "type", "fill", "press", "scroll", "select", "navigate"] },
        ref: { type: "string" },
        selector: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        url: { type: "string" },
        expect: { type: "object" }
      },
      required: ["kind"]
    }
  },
  {
    name: "browser_verify",
    description: "Verify current browser state after action",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        expect: { type: "object" }
      },
      required: []
    }
  },
  {
    name: "list_tabs",
    description: "List available browser tabs",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "open_tab",
    description: "Open a new browser tab",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean" }
      },
      required: ["url"]
    }
  }
];

function normalizeName(input: unknown): string {
  return String(input || "").trim();
}

function cloneRecord(input: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(input));
}

function cloneContract(contract: ToolContract): ToolContract {
  return {
    name: contract.name,
    description: contract.description,
    parameters: cloneRecord(contract.parameters),
    aliases: Array.isArray(contract.aliases) ? [...contract.aliases] : []
  };
}

function validateContract(contract: ToolContract): ToolContract {
  const name = normalizeName(contract.name);
  if (!name) throw new Error("tool contract name 不能为空");
  const description = String(contract.description || "").trim();
  if (!description) throw new Error(`tool contract description 不能为空: ${name}`);
  const parameters = contract.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error(`tool contract parameters 必须是 object: ${name}`);
  }
  const aliases = Array.isArray(contract.aliases)
    ? contract.aliases
        .map((item) => normalizeName(item))
        .filter(Boolean)
        .filter((alias, index, list) => list.indexOf(alias) === index && alias !== name)
    : [];
  return {
    name,
    description,
    parameters: cloneRecord(parameters),
    aliases
  };
}

export class ToolContractRegistry {
  private readonly builtins = new Map<string, ToolContract>();
  private readonly overrides = new Map<string, ToolContract>();
  private readonly builtinAlias = new Map<string, string>();
  private readonly overrideAlias = new Map<string, string>();

  constructor(defaultContracts: ToolContract[] = DEFAULT_TOOL_CONTRACTS) {
    for (const contract of defaultContracts) {
      const normalized = validateContract(contract);
      this.builtins.set(normalized.name, normalized);
      for (const alias of normalized.aliases || []) {
        this.builtinAlias.set(alias, normalized.name);
      }
    }
  }

  register(contract: ToolContract, options: RegisterToolContractOptions = {}): void {
    const normalized = validateContract(contract);
    const exists = this.overrides.has(normalized.name) || this.builtins.has(normalized.name);
    if (exists && !options.replace) {
      throw new Error(`tool contract already registered: ${normalized.name}`);
    }

    const previous = this.overrides.get(normalized.name);
    if (previous) {
      for (const alias of previous.aliases || []) this.overrideAlias.delete(alias);
    }
    this.overrides.set(normalized.name, normalized);
    for (const alias of normalized.aliases || []) {
      this.overrideAlias.set(alias, normalized.name);
    }
  }

  unregister(name: string): boolean {
    const normalizedName = normalizeName(name);
    const previous = this.overrides.get(normalizedName);
    if (!previous) return false;
    for (const alias of previous.aliases || []) {
      this.overrideAlias.delete(alias);
    }
    this.overrides.delete(normalizedName);
    return true;
  }

  resolve(nameOrAlias: string): ToolContract | null {
    const key = normalizeName(nameOrAlias);
    if (!key) return null;
    const overrideByName = this.overrides.get(key);
    if (overrideByName) return cloneContract(overrideByName);
    const builtinByName = this.builtins.get(key);
    if (builtinByName) return cloneContract(builtinByName);

    const overrideName = this.overrideAlias.get(key);
    if (overrideName) {
      const contract = this.overrides.get(overrideName);
      if (contract) return cloneContract(contract);
    }
    const builtinName = this.builtinAlias.get(key);
    if (builtinName) {
      const override = this.overrides.get(builtinName);
      if (override) return cloneContract(override);
      const builtin = this.builtins.get(builtinName);
      if (builtin) return cloneContract(builtin);
    }

    return null;
  }

  listContracts(): ToolContractView[] {
    const out: ToolContractView[] = [];

    for (const [name, builtin] of this.builtins.entries()) {
      const resolved = this.overrides.get(name) || builtin;
      out.push({
        name: resolved.name,
        description: resolved.description,
        aliases: [...(resolved.aliases || [])],
        source: this.overrides.has(name) ? "override" : "builtin"
      });
    }
    for (const [name, override] of this.overrides.entries()) {
      if (this.builtins.has(name)) continue;
      out.push({
        name: override.name,
        description: override.description,
        aliases: [...(override.aliases || [])],
        source: "override"
      });
    }

    return out;
  }

  listLlmToolDefinitions(options: { includeAliases?: boolean } = {}): ToolDefinition[] {
    const includeAliases = options.includeAliases !== false;
    const out: ToolDefinition[] = [];
    const seen = new Set<string>();

    const pushDefinition = (name: string, description: string, parameters: JsonRecord) => {
      const normalized = normalizeName(name);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      out.push({
        type: "function",
        function: {
          name: normalized,
          description,
          parameters: cloneRecord(parameters)
        }
      });
    };

    const entries = this.listContracts();
    for (const entry of entries) {
      const resolved = this.resolve(entry.name);
      if (!resolved) continue;
      pushDefinition(resolved.name, resolved.description, resolved.parameters);
      if (!includeAliases) continue;
      for (const alias of resolved.aliases || []) {
        pushDefinition(alias, resolved.description, resolved.parameters);
      }
    }

    return out;
  }
}

