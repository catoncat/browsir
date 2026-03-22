import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  normalizeMcpServerConfig,
  type McpServerConfig,
} from "../../shared/mcp-config";

export interface BrowserMcpDiscoveredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BrowserMcpListToolsResult {
  serverId: string;
  transport: "streamable-http";
  tools: BrowserMcpDiscoveredTool[];
}

export interface BrowserMcpCallToolResult {
  serverId: string;
  toolName: string;
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

interface BrowserMcpClientSession {
  fingerprint: string;
  server: McpServerConfig;
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asNonEmptyString(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return text;
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

function fingerprintServer(server: McpServerConfig): string {
  return JSON.stringify(sortJsonValue(server));
}

function toDiscoveredTool(tool: Record<string, unknown>): BrowserMcpDiscoveredTool {
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

function normalizeRemoteMcpServerConfig(raw: unknown): McpServerConfig {
  const server = normalizeMcpServerConfig(raw, "mcp_server");
  if (server.transport !== "streamable-http") {
    throw new Error("browser MCP registry 仅支持 streamable-http");
  }
  const url = asNonEmptyString(server.url, "server.url");
  try {
    new URL(url);
  } catch (error) {
    throw new Error(
      `server.url must be a valid URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    ...server,
    url,
  };
}

async function closeSession(
  session: BrowserMcpClientSession | undefined,
): Promise<void> {
  if (!session) return;
  try {
    await session.transport.terminateSession();
  } catch {
    // Best effort only. Many servers simply ignore DELETE session teardown.
  }
  try {
    await session.client.close();
  } catch {
    // Best effort only.
  }
}

export class BrowserMcpClientRegistry {
  private readonly sessions = new Map<string, BrowserMcpClientSession>();
  private readonly pending = new Map<string, Promise<BrowserMcpClientSession>>();

  private async createSession(
    server: McpServerConfig,
  ): Promise<BrowserMcpClientSession> {
    const transport = new StreamableHTTPClientTransport(new URL(server.url || ""), {
      ...(server.headers && Object.keys(server.headers).length > 0
        ? {
            requestInit: {
              headers: new Headers(server.headers),
            },
          }
        : {}),
    });
    const client = new Client({
      name: "browser-brain-loop-extension",
      version: "1.0.0",
    });

    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(
        `MCP browser transport 连接失败 (${server.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      fingerprint: fingerprintServer(server),
      server,
      client,
      transport,
    };
  }

  async connectServer(
    rawServer: unknown,
    options: { refresh?: boolean } = {},
  ): Promise<BrowserMcpClientSession> {
    const server = normalizeRemoteMcpServerConfig(rawServer);
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
  ): Promise<BrowserMcpListToolsResult> {
    const session = await this.connectServer(rawServer, options);
    const tools: BrowserMcpDiscoveredTool[] = [];
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
      throw new Error(
        `MCP browser tools 枚举失败 (${session.server.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      serverId: session.server.id,
      transport: "streamable-http",
      tools,
    };
  }

  async callTool(input: {
    server: unknown;
    toolName: unknown;
    arguments?: unknown;
  }): Promise<BrowserMcpCallToolResult> {
    const session = await this.connectServer(input.server);
    const toolName = asNonEmptyString(input.toolName, "toolName");
    const toolArgs =
      input.arguments === undefined
        ? {}
        : isPlainObject(input.arguments)
          ? input.arguments
          : (() => {
              throw new Error("arguments must be an object");
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
      throw new Error(
        `MCP browser tool 调用失败 (${session.server.id}/${toolName}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
      // Pending connect already failed; nothing else to clean up.
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

export const browserMcpClientRegistry = new BrowserMcpClientRegistry();

export async function resetBrowserMcpClientRegistryForTest(): Promise<void> {
  await browserMcpClientRegistry.closeAll();
}
