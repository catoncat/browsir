import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BridgeError } from "../errors";
import type {
  McpCallToolResult,
  McpDiscoveredTool,
  McpListToolsResult,
  McpTransport,
  NormalizedMcpServerConfig,
} from "./types";

interface McpClientSession {
  fingerprint: string;
  server: NormalizedMcpServerConfig;
  client: Client;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new BridgeError("E_ARGS", `${field} must be a non-empty string`);
  }
  return text;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new BridgeError("E_ARGS", `${field} must be a string`);
  }
  const text = value.trim();
  return text || undefined;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BridgeError("E_ARGS", `${field} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new BridgeError("E_ARGS", `${field} must be an array of strings`);
    }
    out.push(item);
  }
  return out;
}

function cloneStringRecord(
  value: unknown,
  field: string,
  options: {
    normalizeKey?: (key: string) => string;
  } = {},
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new BridgeError("E_ARGS", `${field} must be a string record`);
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const baseKey = asOptionalString(rawKey, `${field}.key`);
    const normalizedValue = asOptionalString(rawValue, `${field}.${rawKey}`);
    if (!baseKey || !normalizedValue) continue;
    const key = options.normalizeKey ? options.normalizeKey(baseKey) : baseKey;
    if (!key) continue;
    out[key] = normalizedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeTransport(value: unknown): McpTransport {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "stdio" || text === "streamable-http") return text;
  throw new BridgeError(
    "E_ARGS",
    "server.transport must be stdio or streamable-http",
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

function fingerprintServer(server: NormalizedMcpServerConfig): string {
  return JSON.stringify(sortJsonValue(server));
}

function toDiscoveredTool(tool: Record<string, unknown>): McpDiscoveredTool {
  const name = asNonEmptyString(tool.name, "tool.name");
  const title =
    (typeof tool.title === "string" && tool.title.trim()) ||
    (isPlainObject(tool.annotations) &&
    typeof tool.annotations.title === "string" &&
    tool.annotations.title.trim()
      ? String(tool.annotations.title).trim()
      : "") ||
    name;
  const description =
    typeof tool.description === "string" ? tool.description.trim() : "";
  return {
    name,
    title,
    description,
    inputSchema: isPlainObject(tool.inputSchema)
      ? { ...tool.inputSchema }
      : { type: "object", properties: {}, required: [] },
  };
}

export function normalizeMcpServerConfig(
  raw: unknown,
): NormalizedMcpServerConfig {
  if (!isPlainObject(raw)) {
    throw new BridgeError("E_ARGS", "server must be an object");
  }

  const id = asNonEmptyString(raw.id, "server.id");
  const transport = normalizeTransport(raw.transport);
  const env = cloneStringRecord(raw.env, "server.env");
  const headers = cloneStringRecord(raw.headers, "server.headers", {
    normalizeKey: (key) => key.toLowerCase(),
  });

  if (transport === "stdio") {
    return {
      id,
      transport,
      command: asNonEmptyString(raw.command, "server.command"),
      args: asStringArray(raw.args, "server.args"),
      ...(asOptionalString(raw.cwd, "server.cwd")
        ? { cwd: asOptionalString(raw.cwd, "server.cwd") }
        : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  const url = asNonEmptyString(raw.url, "server.url");
  try {
    new URL(url);
  } catch (error) {
    throw new BridgeError("E_ARGS", "server.url must be a valid URL", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    id,
    transport,
    url,
    ...(headers ? { headers } : {}),
    ...(env ? { env } : {}),
  };
}

async function closeSession(session: McpClientSession | undefined): Promise<void> {
  if (!session) return;
  try {
    await session.client.close();
  } catch {
    // Best effort teardown only.
  }
}

export class McpClientRegistry {
  private readonly sessions = new Map<string, McpClientSession>();
  private readonly pending = new Map<string, Promise<McpClientSession>>();

  private async createSession(
    server: NormalizedMcpServerConfig,
  ): Promise<McpClientSession> {
    const client = new Client({
      name: "browser-brain-loop-bridge",
      version: "1.0.0",
    });

    try {
      if (server.transport === "stdio") {
        await client.connect(
          new StdioClientTransport({
            command: server.command || "",
            args: server.args || [],
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(server.env ? { env: server.env } : {}),
            stderr: "pipe",
          }),
        );
      } else {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url || ""), {
            ...(server.headers
              ? {
                  requestInit: {
                    headers: new Headers(server.headers),
                  },
                }
              : {}),
          }),
        );
      }
    } catch (error) {
      throw new BridgeError("E_MCP_CONNECT", "MCP server 连接失败", {
        serverId: server.id,
        transport: server.transport,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      fingerprint: fingerprintServer(server),
      server,
      client,
    };
  }

  async connectServer(
    rawServer: unknown,
    options: { refresh?: boolean } = {},
  ): Promise<McpClientSession> {
    const server = normalizeMcpServerConfig(rawServer);
    const fingerprint = fingerprintServer(server);
    const current = this.sessions.get(server.id);
    if (
      current &&
      current.fingerprint === fingerprint &&
      options.refresh !== true
    ) {
      return current;
    }

    const existingTask = this.pending.get(server.id);
    if (existingTask) return await existingTask;

    const task = (async () => {
      const latest = this.sessions.get(server.id);
      if (
        latest &&
        latest.fingerprint === fingerprint &&
        options.refresh !== true
      ) {
        return latest;
      }
      if (latest) {
        this.sessions.delete(server.id);
        await closeSession(latest);
      }
      const created = await this.createSession(server);
      this.sessions.set(server.id, created);
      return created;
    })();

    this.pending.set(server.id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(server.id);
    }
  }

  async listTools(
    rawServer: unknown,
    options: { refresh?: boolean } = {},
  ): Promise<McpListToolsResult> {
    const session = await this.connectServer(rawServer, options);
    const tools: McpDiscoveredTool[] = [];
    let cursor: string | undefined;
    try {
      do {
        const result = await session.client.listTools(
          cursor ? { cursor } : undefined,
        );
        for (const item of result.tools || []) {
          tools.push(toDiscoveredTool(item as Record<string, unknown>));
        }
        cursor =
          typeof result.nextCursor === "string" && result.nextCursor.trim()
            ? result.nextCursor
            : undefined;
      } while (cursor);
    } catch (error) {
      throw new BridgeError("E_MCP_LIST_TOOLS", "MCP tools 枚举失败", {
        serverId: session.server.id,
        transport: session.server.transport,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      serverId: session.server.id,
      transport: session.server.transport,
      tools,
    };
  }

  async callTool(input: {
    server: unknown;
    toolName: unknown;
    arguments?: unknown;
  }): Promise<McpCallToolResult> {
    const session = await this.connectServer(input.server);
    const toolName = asNonEmptyString(input.toolName, "toolName");
    const toolArgs =
      input.arguments === undefined
        ? {}
        : isPlainObject(input.arguments)
          ? input.arguments
          : (() => {
              throw new BridgeError("E_ARGS", "arguments must be an object");
            })();

    try {
      const result = await session.client.callTool({
        name: toolName,
        arguments: toolArgs,
      });
      return {
        serverId: session.server.id,
        toolName,
        content: Array.isArray(result.content) ? result.content : [],
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        isError: result.isError === true,
        ...(isPlainObject(result._meta) ? { _meta: result._meta } : {}),
      };
    } catch (error) {
      throw new BridgeError("E_MCP_CALL_TOOL", "MCP tool 调用失败", {
        serverId: session.server.id,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async closeServer(serverId: unknown): Promise<boolean> {
    const normalizedId = asNonEmptyString(serverId, "serverId");
    const current = this.sessions.get(normalizedId);
    const pendingTask = this.pending.get(normalizedId);
    this.sessions.delete(normalizedId);

    await closeSession(current);

    if (!pendingTask) {
      return Boolean(current);
    }

    try {
      const pendingSession = await pendingTask;
      if (this.sessions.get(normalizedId) === pendingSession) {
        this.sessions.delete(normalizedId);
      }
      await closeSession(pendingSession);
    } catch {
      // Pending connect already failed; nothing else to tear down.
    }

    return true;
  }

  async closeAll(): Promise<void> {
    const serverIds = new Set<string>([
      ...Array.from(this.sessions.keys()),
      ...Array.from(this.pending.keys()),
    ]);
    await Promise.all(
      Array.from(serverIds).map((serverId) => this.closeServer(serverId)),
    );
  }
}

export const mcpClientRegistry = new McpClientRegistry();

export async function resetMcpClientRegistryForTest(): Promise<void> {
  await mcpClientRegistry.closeAll();
}
