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
    description:
      "Execute a shell command via bash.exec. Use runtime=browser for browser virtual runtime, runtime=local for local shell.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint for command execution backend."
        },
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
    description:
      "Read a file's content. mem:// or vfs:// paths target browser virtual files; regular paths target local files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint. Prefer matching the path semantics."
        },
        offset: { type: "number" },
        limit: { type: "number" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description:
      "Write content to a file. mem:// or vfs:// paths target browser virtual files; regular paths target local files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint. Prefer matching the path semantics."
        },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append", "create"] }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description:
      "Apply edits to a file. mem:// or vfs:// paths target browser virtual files; regular paths target local files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint. Prefer matching the path semantics."
        },
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
    name: "search_elements",
    description:
      "Search interactive elements from an accessibility snapshot and return uid/ref/backendNodeId targets for follow-up actions. Prefer user-visible semantic query words (placeholder/aria/name/visible text) instead of implementation-only selectors.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        query: {
          type: "string",
          description: "User-visible semantic query (e.g. search, like, submit, email)."
        },
        selector: {
          type: "string",
          description: "Optional scope selector to narrow search region."
        },
        maxResults: { type: "number", description: "Max matched nodes to return (default 20)." },
        maxTokens: { type: "number", description: "Snapshot token budget hint." },
        depth: { type: "number", description: "DOM/a11y traversal depth hint." },
        noAnimations: { type: "boolean", description: "Disable animations during snapshot for stability." }
      },
      required: []
    }
  },
  {
    name: "click",
    description:
      "Click an element by uid/ref/backendNodeId from search_elements. Prefer fresh uid/ref targets. Add expect when this click should cause a state change.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        uid: { type: "string", description: "Element uid from search_elements." },
        ref: { type: "string", description: "Stable ref from search_elements." },
        backendNodeId: { type: "number", description: "Stable backend node id." },
        selector: {
          type: "string",
          description: "Fallback selector only. Prefer uid/ref/backendNodeId."
        },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation (url/text/selector)."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      anyOf: [{ required: ["uid"] }, { required: ["ref"] }, { required: ["backendNodeId"] }],
      required: []
    }
  },
  {
    name: "fill_element_by_uid",
    description:
      "Fill/type into an element by uid/ref/backendNodeId from search_elements. Works for input/textarea/contenteditable editors.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        uid: { type: "string", description: "Element uid from search_elements." },
        ref: { type: "string", description: "Stable ref from search_elements." },
        backendNodeId: { type: "number", description: "Stable backend node id." },
        selector: {
          type: "string",
          description: "Fallback selector only. Prefer uid/ref/backendNodeId."
        },
        value: { type: "string", description: "Value/text to fill." },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      anyOf: [{ required: ["uid"] }, { required: ["ref"] }, { required: ["backendNodeId"] }],
      required: ["value"]
    }
  },
  {
    name: "select_option_by_uid",
    description:
      "Select/set value for a selectable element by uid/ref/backendNodeId from search_elements. Useful for <select> and similar controls.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        uid: { type: "string", description: "Element uid from search_elements." },
        ref: { type: "string", description: "Stable ref from search_elements." },
        backendNodeId: { type: "number", description: "Stable backend node id." },
        selector: {
          type: "string",
          description: "Fallback selector only. Prefer uid/ref/backendNodeId."
        },
        value: { type: "string", description: "Option value to set." },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      anyOf: [{ required: ["uid"] }, { required: ["ref"] }, { required: ["backendNodeId"] }],
      required: ["value"]
    }
  },
  {
    name: "press_key",
    description:
      "Send a keyboard key to the active element on a tab (e.g. Enter, Escape, ArrowDown).",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        key: { type: "string", description: "Key name to press." },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      required: ["key"]
    }
  },
  {
    name: "scroll_page",
    description:
      "Scroll current page by deltaY pixels. Positive moves down, negative moves up.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        deltaY: { type: "number", description: "Pixels to scroll (default 600)." },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      required: []
    }
  },
  {
    name: "navigate_tab",
    description:
      "Navigate a tab to the given URL. Use expect to verify destination when needed.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        url: { type: "string", description: "Destination URL." },
        expect: {
          type: "object",
          description: "Optional post-action verification expectation."
        },
        requireFocus: { type: "boolean", description: "Require focused tab before action." },
        forceFocus: { type: "boolean", description: "Auto-focus tab before action." }
      },
      required: ["url"]
    }
  },
  {
    name: "fill_form",
    description: "Fill multiple form fields in one step using uid/ref/backendNodeId from search_elements.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        elements: {
          type: "array",
          items: {
            type: "object",
            properties: {
              uid: { type: "string" },
              ref: { type: "string" },
              backendNodeId: { type: "number" },
              selector: { type: "string" },
              value: { type: "string" }
            },
            required: ["value"]
          }
        },
        submit: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["click", "press"] },
            uid: { type: "string" },
            ref: { type: "string" },
            selector: { type: "string" },
            key: { type: "string" }
          }
        },
        expect: { type: "object" }
      },
      required: ["elements"]
    }
  },
  {
    name: "browser_verify",
    description:
      "Verify current browser state after action. Provide a non-empty expect object (url/title/text/selector checks) for deterministic validation.",
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
    name: "get_all_tabs",
    description: "Get all open tabs across all windows with metadata",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_current_tab",
    description: "Get information about the currently active tab",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "create_new_tab",
    description: "Create a new browser tab with the provided URL",
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
