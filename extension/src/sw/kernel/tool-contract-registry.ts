type JsonRecord = Record<string, unknown>;

export interface ToolContract {
  name: string;
  description: string;
  parameters: JsonRecord;
}

export interface RegisterToolContractOptions {
  replace?: boolean;
}

export interface ToolContractView {
  name: string;
  description: string;
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

const TARGET_PROPERTIES: JsonRecord = {
  tabId: { type: "number", description: "Target tab id. Omit to use run-scope tab." },
  uid: { type: "string", description: "Element uid from latest search_elements result." },
  ref: { type: "string", description: "Stable element ref from latest search_elements result." },
  backendNodeId: { type: "number", description: "Stable backend DOM node id from latest snapshot." },
  selector: {
    type: "string",
    description: "Fallback CSS selector. Prefer uid/ref/backendNodeId first."
  },
  expect: {
    type: "object",
    description: "Post-action expectation for deterministic verify (url/title/text/selector checks)."
  },
  requireFocus: { type: "boolean", description: "Fail fast if tab is not focused." },
  forceFocus: { type: "boolean", description: "Auto-focus target tab before action." }
};

const TARGET_ANY_OF = [
  { required: ["uid"] },
  { required: ["ref"] },
  { required: ["backendNodeId"] },
  { required: ["selector"] }
];

const FILE_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: "bash",
    description:
      "Execute a shell command via bash.exec. Use bridge runtime for command-line inspection/build tasks. On timeout, increase timeoutMs and retry the same goal.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "browser=virtual fs runtime, local=host shell runtime."
        },
        timeoutMs: {
          type: "number",
          description: "Execution timeout in milliseconds."
        }
      },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description:
      "Read file text content. Use before edit/write to ground changes. On path error, fix path and retry.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path. mem:// or vfs:// routes to browser virtual fs." },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint."
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
      "Write file content (overwrite/append/create). Use for new files or full rewrites. Prefer edit_file for surgical patching.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path." },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint."
        },
        content: { type: "string", description: "Text content to write." },
        mode: { type: "string", enum: ["overwrite", "append", "create"] }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description:
      "Apply exact text replacements. Use when patching existing file sections. If old text not found, read_file first and retry with exact context.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Target file path." },
        runtime: {
          type: "string",
          enum: ["browser", "local"],
          description: "Optional runtime hint."
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
  }
];

const BROWSER_TOOL_CONTRACTS: ToolContract[] = [
  {
    name: "get_all_tabs",
    description:
      "List all open tabs. Use when tab context is ambiguous before browser actions.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "get_current_tab",
    description: "Return active tab information.",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "create_new_tab",
    description:
      "Open a new tab with URL. Use for navigation bootstrap when current tab is unsuitable.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL." },
        active: { type: "boolean", description: "Whether new tab should be active." }
      },
      required: ["url"]
    }
  },
  {
    name: "get_tab_info",
    description: "Get detailed info for a tab id. Use after get_all_tabs when selecting targets.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." }
      },
      required: ["tabId"]
    }
  },
  {
    name: "close_tab",
    description:
      "Close a tab (or current tab if omitted). Use with care because it is destructive.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional target tab id. Defaults to current tab." }
      },
      required: []
    }
  },
  {
    name: "ungroup_tabs",
    description: "Ungroup all tab groups in current window.",
    parameters: {
      type: "object",
      properties: {
        windowId: { type: "number", description: "Optional window id. Defaults to active window." }
      },
      required: []
    }
  },
  {
    name: "search_elements",
    description:
      "Search interactive elements from accessibility snapshot. Use semantic query terms (placeholder/aria/name/text). If no hit, change query strategy before retrying.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        query: {
          type: "string",
          description: "Semantic query words (e.g. like, submit, email, search)."
        },
        selector: { type: "string", description: "Optional scope selector." },
        maxResults: { type: "number", description: "Maximum returned nodes." },
        maxTokens: { type: "number", description: "Snapshot token budget." },
        depth: { type: "number", description: "Traversal depth hint." },
        noAnimations: { type: "boolean", description: "Disable animations for stable snapshots." }
      },
      required: []
    }
  },
  {
    name: "click",
    description:
      "Click target element from latest snapshot. Preconditions: must provide uid/ref/backendNodeId/selector. If E_REF_REQUIRED, call search_elements again.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        dblClick: { type: "boolean", description: "Double click instead of single click." }
      },
      anyOf: TARGET_ANY_OF,
      required: []
    }
  },
  {
    name: "fill_element_by_uid",
    description:
      "Fill text into input/textarea/contenteditable target. Preconditions: target + non-empty value. For stateful forms, pair with expect.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        value: { type: "string", description: "Text value to input." }
      },
      anyOf: TARGET_ANY_OF,
      required: ["value"]
    }
  },
  {
    name: "select_option_by_uid",
    description:
      "Set selected value on select-like control. Preconditions: target + value. If selection seems stale, refresh with search_elements then retry.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        value: { type: "string", description: "Option value." }
      },
      anyOf: TARGET_ANY_OF,
      required: ["value"]
    }
  },
  {
    name: "hover_element_by_uid",
    description:
      "Hover a target element to reveal menus/tooltips. Preconditions: provide target from fresh snapshot.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES
      },
      anyOf: TARGET_ANY_OF,
      required: []
    }
  },
  {
    name: "get_editor_value",
    description:
      "Read full value from input/textarea/contenteditable/editor-like target. Use before overwrite to avoid accidental truncation.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES
      },
      anyOf: TARGET_ANY_OF,
      required: []
    }
  },
  {
    name: "press_key",
    description:
      "Press keyboard key on active element. Use for submit/close/navigation shortcuts.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        key: { type: "string", description: "Key name (Enter/Escape/ArrowDown...)." },
        expect: TARGET_PROPERTIES.expect,
        requireFocus: TARGET_PROPERTIES.requireFocus,
        forceFocus: TARGET_PROPERTIES.forceFocus
      },
      required: ["key"]
    }
  },
  {
    name: "scroll_page",
    description:
      "Scroll viewport by deltaY. Use when more content must be revealed before next action.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        deltaY: { type: "number", description: "Scroll delta in pixels. Positive=down." },
        expect: TARGET_PROPERTIES.expect,
        requireFocus: TARGET_PROPERTIES.requireFocus,
        forceFocus: TARGET_PROPERTIES.forceFocus
      },
      required: []
    }
  },
  {
    name: "navigate_tab",
    description:
      "Navigate tab to URL. Prefer expectUrlContains/urlChanged to confirm progress.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        url: { type: "string", description: "Destination URL." },
        expect: TARGET_PROPERTIES.expect,
        requireFocus: TARGET_PROPERTIES.requireFocus,
        forceFocus: TARGET_PROPERTIES.forceFocus
      },
      required: ["url"]
    }
  },
  {
    name: "fill_form",
    description:
      "Fill multiple fields in one call. Preconditions: each field must include target + value. If any field fails, refresh refs with search_elements then retry.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
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
            anyOf: TARGET_ANY_OF,
            required: ["value"]
          }
        },
        submit: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["click", "press"] },
            uid: { type: "string" },
            ref: { type: "string" },
            backendNodeId: { type: "number" },
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
      "Run explicit browser verification checks. Always provide expect with at least one concrete assertion; empty-check verify is invalid.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        expect: {
          type: "object",
          description: "At least one check: expectUrlContains/titleContains/urlChanged/textIncludes/selectorExists."
        }
      },
      required: ["expect"]
    }
  },
  {
    name: "computer",
    description:
      "Coordinate-based browser interaction toolcall. Use only when semantic element targeting is insufficient (canvas/visual UIs).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click",
            "right_click",
            "double_click",
            "triple_click",
            "left_click_drag",
            "hover",
            "scroll",
            "scroll_to",
            "type",
            "key",
            "wait"
          ]
        },
        tabId: { type: "number" },
        coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "[x,y] coordinates in viewport pixel space."
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "Drag start coordinate for left_click_drag."
        },
        text: { type: "string", description: "Text for type/key action." },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number" },
        duration: { type: "number", description: "Seconds for wait action." },
        uid: { type: "string", description: "Element uid for scroll_to." },
        selector: { type: "string", description: "Selector fallback for scroll_to." }
      },
      required: ["action"]
    }
  },
  {
    name: "get_page_metadata",
    description: "Read current page metadata (title/url/description/keywords/author/og).",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional target tab id." }
      },
      required: []
    }
  },
  {
    name: "scroll_to_element",
    description:
      "Scroll target element into view. Preconditions: provide selector or uid/ref/backendNodeId from search_elements.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        behavior: { type: "string", enum: ["auto", "smooth"], description: "Scroll behavior." },
        block: { type: "string", enum: ["start", "center", "end", "nearest"] },
        inline: { type: "string", enum: ["start", "center", "end", "nearest"] }
      },
      anyOf: TARGET_ANY_OF,
      required: []
    }
  },
  {
    name: "highlight_element",
    description: "Highlight target element for visual confirmation/debugging.",
    parameters: {
      type: "object",
      properties: {
        ...TARGET_PROPERTIES,
        color: { type: "string", description: "Outline color, e.g. #00d4ff." },
        durationMs: { type: "number", description: "Highlight duration in ms. 0 keeps highlight until refresh." }
      },
      anyOf: TARGET_ANY_OF,
      required: []
    }
  },
  {
    name: "highlight_text_inline",
    description: "Highlight matched inline text under selector scope.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        selector: { type: "string", description: "Scope selector for text search." },
        searchText: { type: "string", description: "Text to highlight." },
        caseSensitive: { type: "boolean" },
        wholeWords: { type: "boolean" },
        highlightColor: { type: "string" },
        backgroundColor: { type: "string" },
        fontWeight: { type: "string" }
      },
      required: ["selector", "searchText"]
    }
  },
  {
    name: "capture_screenshot",
    description:
      "Capture screenshot for current tab and return base64 data URL. Use for visual analysis when semantic snapshot is insufficient.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Optional target tab id. Defaults to run-scope tab." },
        format: { type: "string", enum: ["png", "jpeg"], description: "Image format." },
        quality: { type: "number", description: "JPEG quality 0-100." },
        sendToLLM: { type: "boolean", description: "Hint that this screenshot is intended for visual reasoning." }
      },
      required: []
    }
  },
  {
    name: "capture_tab_screenshot",
    description: "Capture screenshot for a specific tab id.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Target tab id." },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "number" },
        sendToLLM: { type: "boolean" }
      },
      required: ["tabId"]
    }
  },
  {
    name: "capture_screenshot_with_highlight",
    description:
      "Capture screenshot with optional element highlight. Use for visual debugging and evidence capture.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        selector: { type: "string", description: "Optional selector to highlight before capture." },
        cropToElement: { type: "boolean", description: "Crop around highlighted element when possible." },
        padding: { type: "number", description: "Padding in pixels for crop region." },
        sendToLLM: { type: "boolean" }
      },
      required: []
    }
  },
  {
    name: "download_image",
    description:
      "Trigger browser download from data:image/* URL. Use after screenshot/image generation.",
    parameters: {
      type: "object",
      properties: {
        imageData: { type: "string", description: "data:image/... base64 URL." },
        filename: { type: "string", description: "Optional download filename." },
        tabId: { type: "number", description: "Optional tab id used to trigger download." }
      },
      required: ["imageData"]
    }
  },
  {
    name: "download_chat_images",
    description:
      "Batch-download images from chat-like message payload. messages[].parts[].imageData must be valid data:image URL.",
    parameters: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              parts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    imageData: { type: "string" },
                    imageTitle: { type: "string" }
                  },
                  required: ["type"]
                }
              }
            },
            required: ["id"]
          }
        },
        folderPrefix: { type: "string" },
        filenamingStrategy: { type: "string", enum: ["descriptive", "sequential", "timestamp"] },
        displayResults: { type: "boolean" },
        tabId: { type: "number" }
      },
      required: ["messages"]
    }
  },
  {
    name: "list_interventions",
    description:
      "List available human intervention types. Use when automation needs explicit user action.",
    parameters: {
      type: "object",
      properties: {
        enabledOnly: { type: "boolean", description: "Return only enabled interventions." }
      },
      required: []
    }
  },
  {
    name: "get_intervention_info",
    description: "Get detailed schema and usage for a specific intervention type.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["monitor-operation", "voice-input", "user-selection"],
          description: "Intervention type."
        }
      },
      required: ["type"]
    }
  },
  {
    name: "request_intervention",
    description:
      "Request a human intervention task. Use when required information/action cannot be completed programmatically.",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["monitor-operation", "voice-input", "user-selection"]
        },
        params: { type: "object", description: "Intervention-specific payload." },
        timeout: { type: "number", description: "Timeout in seconds." },
        reason: { type: "string", description: "User-facing reason for intervention." }
      },
      required: ["type"]
    }
  },
  {
    name: "cancel_intervention",
    description: "Cancel a pending intervention request.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Optional intervention request id." }
      },
      required: []
    }
  },
  {
    name: "load_skill",
    description: "Load skill main document (SKILL.md) by skill name/id.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill id or name." }
      },
      required: ["name"]
    }
  },
  {
    name: "execute_skill_script",
    description:
      "Execute a script inside skill package. If script fails or is missing, call get_skill_info/read_skill_reference to re-check path and preconditions.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "Skill id/name." },
        scriptPath: { type: "string", description: "Path under scripts/ directory." },
        args: { description: "Script args payload." }
      },
      required: ["skillName", "scriptPath"]
    }
  },
  {
    name: "read_skill_reference",
    description: "Read a reference file under skill references/ directory.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string" },
        refPath: { type: "string", description: "Path under references/." }
      },
      required: ["skillName", "refPath"]
    }
  },
  {
    name: "get_skill_asset",
    description: "Read an asset under skill assets/ directory.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string" },
        assetPath: { type: "string", description: "Path under assets/." }
      },
      required: ["skillName", "assetPath"]
    }
  },
  {
    name: "list_skills",
    description: "List installed skills and status.",
    parameters: {
      type: "object",
      properties: {
        enabledOnly: { type: "boolean", description: "If true, return only enabled skills." }
      },
      required: []
    }
  },
  {
    name: "get_skill_info",
    description: "Get skill metadata and resolved paths for scripts/references/assets.",
    parameters: {
      type: "object",
      properties: {
        skillName: { type: "string", description: "Skill id or name." }
      },
      required: ["skillName"]
    }
  }
];

const DEFAULT_TOOL_CONTRACTS: ToolContract[] = [...FILE_TOOL_CONTRACTS, ...BROWSER_TOOL_CONTRACTS];

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
    parameters: cloneRecord(contract.parameters)
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
  return {
    name,
    description,
    parameters: cloneRecord(parameters)
  };
}

export class ToolContractRegistry {
  private readonly builtins = new Map<string, ToolContract>();
  private readonly overrides = new Map<string, ToolContract>();

  constructor(defaultContracts: ToolContract[] = DEFAULT_TOOL_CONTRACTS) {
    for (const contract of defaultContracts) {
      const normalized = validateContract(contract);
      this.builtins.set(normalized.name, normalized);
    }
  }

  private listEffectiveContracts(): Array<{ source: "builtin" | "override"; contract: ToolContract }> {
    const out: Array<{ source: "builtin" | "override"; contract: ToolContract }> = [];

    for (const [name, builtin] of this.builtins.entries()) {
      const override = this.overrides.get(name);
      if (override) {
        out.push({ source: "override", contract: override });
      } else {
        out.push({ source: "builtin", contract: builtin });
      }
    }

    for (const [name, override] of this.overrides.entries()) {
      if (this.builtins.has(name)) continue;
      out.push({ source: "override", contract: override });
    }

    return out;
  }

  register(contract: ToolContract, options: RegisterToolContractOptions = {}): void {
    const normalized = validateContract(contract);
    const exists = this.overrides.has(normalized.name) || this.builtins.has(normalized.name);
    if (exists && !options.replace) {
      throw new Error(`tool contract already registered: ${normalized.name}`);
    }
    this.overrides.set(normalized.name, normalized);
  }

  unregister(name: string): boolean {
    const normalizedName = normalizeName(name);
    if (!normalizedName) return false;
    return this.overrides.delete(normalizedName);
  }

  resolve(name: string): ToolContract | null {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const resolved = this.overrides.get(normalized) || this.builtins.get(normalized);
    return resolved ? cloneContract(resolved) : null;
  }

  listContracts(): ToolContractView[] {
    return this.listEffectiveContracts().map((entry) => ({
      name: entry.contract.name,
      description: entry.contract.description,
      source: entry.source
    }));
  }

  listLlmToolDefinitions(): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    const exportedNames = new Set<string>();

    for (const entry of this.listContracts()) {
      const resolved = this.resolve(entry.name);
      if (!resolved) continue;
      if (!resolved.name || exportedNames.has(resolved.name)) continue;
      exportedNames.add(resolved.name);
      out.push({
        type: "function",
        function: {
          name: resolved.name,
          description: resolved.description,
          parameters: cloneRecord(resolved.parameters)
        }
      });
    }

    return out;
  }
}
