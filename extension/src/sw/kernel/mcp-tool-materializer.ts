import {
  normalizeMcpRefConfig,
  normalizeMcpServerList,
  resolveMcpServerRuntimeConfig,
} from "../../shared/mcp-config";
import type { BrainOrchestrator } from "./orchestrator.browser";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import { CAPABILITIES } from "./loop-shared-types";
import type { ToolContract } from "./tool-contract-registry";
import type {
  McpDiscoveredToolInput,
  McpDiscoveredToolRecord,
} from "./mcp-registry";
import { browserMcpClientRegistry } from "./browser-mcp-client-registry";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function cloneSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value)
    ? { ...value }
    : { type: "object", properties: {}, required: [] };
}

function buildMcpDescription(tool: McpDiscoveredToolRecord): string {
  const prefix = `[MCP ${tool.serverId}]`;
  const body = tool.description || tool.title || tool.toolName;
  return `${prefix} ${body}`.trim();
}

export function buildMcpToolContract(
  tool: McpDiscoveredToolRecord,
): ToolContract {
  return {
    name: tool.dynamicToolName,
    description: buildMcpDescription(tool),
    parameters: cloneSchema(tool.inputSchema),
    execution: {
      capability: CAPABILITIES.mcpCall,
      mode: tool.server.transport === "streamable-http" ? "script" : "bridge",
      action: tool.dynamicToolName,
      verifyPolicy: "off",
    },
  };
}

async function disconnectMcpServerSession(
  input: {
    infra: RuntimeInfraHandler;
    serverId: string;
    transport?: string;
  },
): Promise<void> {
  try {
    if (input.transport === "streamable-http") {
      await browserMcpClientRegistry.closeServer(input.serverId);
      return;
    }
    await input.infra.handleMessage({
      type: "bridge.invoke",
      payload: {
        tool: "mcp_disconnect_server",
        args: { serverId: input.serverId },
        sessionId: `mcp-disconnect:${input.serverId}`,
      },
    });
  } catch {
    // Session cleanup is best-effort.
  }
}

function normalizeDiscoveredTools(
  rawTools: unknown,
): McpDiscoveredToolInput[] {
  const toolList = Array.isArray(rawTools)
    ? rawTools.filter(isPlainObject)
    : [];
  return toolList.map((item) => ({
    name: String(item.name || "").trim(),
    ...(typeof item.title === "string" && item.title.trim()
      ? { title: item.title.trim() }
      : {}),
    ...(typeof item.description === "string"
      ? { description: item.description.trim() }
      : {}),
    inputSchema: cloneSchema(item.inputSchema),
  }));
}

export async function syncMcpServerTools(input: {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  serverId: string;
  refresh?: boolean;
}): Promise<{ serverId: string; toolNames: string[] }> {
  const registry = input.orchestrator.getMcpRegistry();
  const server = registry.getServer(input.serverId);
  if (!server) {
    throw new Error(`MCP server 未注册: ${input.serverId}`);
  }
  if (server.enabled === false) {
    await disconnectMcpServerSession({
      infra: input.infra,
      serverId: server.id,
      transport: server.transport,
    });
    const removed = registry.removeServer(server.id);
    for (const name of removed) {
      input.orchestrator.unregisterToolContract(name);
    }
    return { serverId: server.id, toolNames: [] };
  }

  try {
    let normalizedTools: McpDiscoveredToolInput[];
    if (server.transport === "streamable-http") {
      const browserResult = await browserMcpClientRegistry.listTools(server, {
        refresh: input.refresh === true,
      });
      normalizedTools = normalizeDiscoveredTools(browserResult.tools);
    } else {
      const bridgeResult = await input.infra.handleMessage({
        type: "bridge.invoke",
        payload: {
          tool: "mcp_list_tools",
          args: {
            server,
            refresh: input.refresh === true,
          },
          sessionId: `mcp-sync:${server.id}`,
        },
      });
      if (!bridgeResult || bridgeResult.ok !== true) {
        throw new Error(`MCP bridge 调用失败: ${server.id}`);
      }

      const invokeResult = toRecord(bridgeResult.data);
      if (invokeResult.ok !== true) {
        throw new Error(
          String(toRecord(invokeResult.error).message || "MCP tools 枚举失败"),
        );
      }

      normalizedTools = normalizeDiscoveredTools(toRecord(invokeResult.data).tools);
    }

    const next = registry.replaceServerTools(server.id, normalizedTools);
    for (const name of next.removed) {
      input.orchestrator.unregisterToolContract(name);
    }
    for (const tool of next.active) {
      input.orchestrator.registerToolContract(buildMcpToolContract(tool), {
        replace: true,
      });
    }
    return {
      serverId: server.id,
      toolNames: next.active.map((item) => item.dynamicToolName),
    };
  } catch (error) {
    await disconnectMcpServerSession({
      infra: input.infra,
      serverId: server.id,
      transport: server.transport,
    });
    throw error;
  }
}

function unregisterToolNames(
  orchestrator: BrainOrchestrator,
  toolNames: string[],
): void {
  for (const name of toolNames) {
    orchestrator.unregisterToolContract(name);
  }
}

export async function syncConfiguredMcpServers(input: {
  orchestrator: BrainOrchestrator;
  infra: RuntimeInfraHandler;
  servers: unknown;
  refs?: unknown;
  refresh?: boolean;
}): Promise<{
  activeServerIds: string[];
  toolNames: string[];
  failures: Array<{ serverId: string; message: string }>;
}> {
  const configuredServers = normalizeMcpServerList(input.servers);
  const refs = normalizeMcpRefConfig(input.refs);
  const registry = input.orchestrator.getMcpRegistry();
  const configuredIds = new Set(configuredServers.map((item) => item.id));

  for (const existing of input.orchestrator.listMcpServers()) {
    if (configuredIds.has(existing.id)) continue;
    await disconnectMcpServerSession({
      infra: input.infra,
      serverId: existing.id,
      transport: existing.transport,
    });
    unregisterToolNames(input.orchestrator, registry.removeServer(existing.id));
  }

  const activeServerIds: string[] = [];
  const toolNames: string[] = [];
  const failures: Array<{ serverId: string; message: string }> = [];

  for (const server of configuredServers) {
    const resolvedServer = resolveMcpServerRuntimeConfig(server, refs);
    const existing = registry.getServer(server.id);
    if (server.enabled === false) {
      if (existing) {
        await disconnectMcpServerSession({
          infra: input.infra,
          serverId: existing.id,
          transport: existing.transport,
        });
      }
      unregisterToolNames(input.orchestrator, registry.removeServer(server.id));
      continue;
    }

    if (existing && existing.transport !== resolvedServer.transport) {
      await disconnectMcpServerSession({
        infra: input.infra,
        serverId: existing.id,
        transport: existing.transport,
      });
    }

    input.orchestrator.upsertMcpServer(resolvedServer);
    try {
      const synced = await syncMcpServerTools({
        orchestrator: input.orchestrator,
        infra: input.infra,
        serverId: resolvedServer.id,
        refresh: input.refresh === true,
      });
      activeServerIds.push(resolvedServer.id);
      toolNames.push(...synced.toolNames);
    } catch (error) {
      unregisterToolNames(
        input.orchestrator,
        registry.removeServer(resolvedServer.id),
      );
      failures.push({
        serverId: resolvedServer.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    activeServerIds,
    toolNames,
    failures,
  };
}
