import {
  sanitizeMcpIdentifier,
  type McpServerConfig,
} from "../../shared/mcp-config";

export type { McpTransport, McpServerConfig } from "../../shared/mcp-config";

export interface McpDiscoveredToolInput {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpDiscoveredToolRecord {
  serverId: string;
  toolName: string;
  dynamicToolName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: McpServerConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cloneSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value)
    ? { ...value }
    : { type: "object", properties: {}, required: [] };
}

function cloneServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    id: String(config.id || "").trim(),
    ...(typeof config.label === "string" && config.label.trim()
      ? { label: config.label.trim() }
      : {}),
    enabled: config.enabled !== false,
    transport:
      config.transport === "streamable-http" ? "streamable-http" : "stdio",
    ...(typeof config.command === "string" && config.command.trim()
      ? { command: config.command.trim() }
      : {}),
    ...(Array.isArray(config.args)
      ? { args: config.args.filter((item) => typeof item === "string") }
      : {}),
    ...(typeof config.cwd === "string" && config.cwd.trim()
      ? { cwd: config.cwd.trim() }
      : {}),
    ...(cloneStringRecord(config.env) ? { env: cloneStringRecord(config.env) } : {}),
    ...(typeof config.url === "string" && config.url.trim()
      ? { url: config.url.trim() }
      : {}),
    ...(cloneStringRecord(config.headers)
      ? { headers: cloneStringRecord(config.headers) }
      : {}),
    ...(typeof config.envRef === "string" && config.envRef.trim()
      ? { envRef: config.envRef.trim() }
      : {}),
    ...(typeof config.authRef === "string" && config.authRef.trim()
      ? { authRef: config.authRef.trim() }
      : {}),
  };
}

export function toMcpDynamicToolName(serverId: string, toolName: string): string {
  const safeServerId = sanitizeMcpIdentifier(serverId);
  const safeToolName = sanitizeMcpIdentifier(toolName);
  if (!safeServerId || !safeToolName) {
    throw new Error("MCP tool name 规范化失败");
  }
  return `mcp__${safeServerId}__${safeToolName}`;
}

export class McpRegistry {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly toolsByName = new Map<string, McpDiscoveredToolRecord>();
  private readonly toolNamesByServer = new Map<string, string[]>();

  upsertServer(config: McpServerConfig): McpServerConfig {
    const next = cloneServerConfig(config);
    if (!next.id) throw new Error("McpServerConfig.id 不能为空");
    this.servers.set(next.id, next);
    return cloneServerConfig(next);
  }

  getServer(serverId: string): McpServerConfig | null {
    const server = this.servers.get(String(serverId || "").trim());
    return server ? cloneServerConfig(server) : null;
  }

  listServers(): McpServerConfig[] {
    return Array.from(this.servers.values()).map((item) => cloneServerConfig(item));
  }

  removeServer(serverId: string): string[] {
    const normalizedId = String(serverId || "").trim();
    if (!normalizedId) return [];
    this.servers.delete(normalizedId);
    const previousNames = this.toolNamesByServer.get(normalizedId) || [];
    this.toolNamesByServer.delete(normalizedId);
    for (const name of previousNames) {
      this.toolsByName.delete(name);
    }
    return [...previousNames];
  }

  replaceServerTools(
    serverId: string,
    tools: McpDiscoveredToolInput[],
  ): {
    active: McpDiscoveredToolRecord[];
    added: string[];
    removed: string[];
  } {
    const server = this.servers.get(String(serverId || "").trim());
    if (!server) {
      throw new Error(`MCP server 未注册: ${serverId}`);
    }

    const previousNames = new Set(this.toolNamesByServer.get(server.id) || []);
    const nextNames: string[] = [];
    const active: McpDiscoveredToolRecord[] = [];
    const added: string[] = [];

    for (const item of tools) {
      const toolName = String(item.name || "").trim();
      if (!toolName) continue;
      const dynamicToolName = toMcpDynamicToolName(server.id, toolName);
      const record: McpDiscoveredToolRecord = {
        serverId: server.id,
        toolName,
        dynamicToolName,
        title:
          (typeof item.title === "string" && item.title.trim()) || toolName,
        description:
          typeof item.description === "string" ? item.description.trim() : "",
        inputSchema: cloneSchema(item.inputSchema),
        server: cloneServerConfig(server),
      };
      if (!previousNames.has(dynamicToolName)) {
        added.push(dynamicToolName);
      }
      nextNames.push(dynamicToolName);
      active.push(record);
      this.toolsByName.set(dynamicToolName, record);
      previousNames.delete(dynamicToolName);
    }

    const removed = Array.from(previousNames);
    for (const name of removed) {
      this.toolsByName.delete(name);
    }
    this.toolNamesByServer.set(server.id, nextNames);

    return { active, added, removed };
  }

  getTool(dynamicToolName: string): McpDiscoveredToolRecord | null {
    const tool = this.toolsByName.get(String(dynamicToolName || "").trim());
    if (!tool) return null;
    return {
      ...tool,
      inputSchema: cloneSchema(tool.inputSchema),
      server: cloneServerConfig(tool.server),
    };
  }

  listTools(): McpDiscoveredToolRecord[] {
    return Array.from(this.toolsByName.values()).map((item) => ({
      ...item,
      inputSchema: cloneSchema(item.inputSchema),
      server: cloneServerConfig(item.server),
    }));
  }
}
