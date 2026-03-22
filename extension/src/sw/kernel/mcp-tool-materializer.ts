import { normalizeMcpServerList } from "../../shared/mcp-config";
import type { BrainOrchestrator } from "./orchestrator.browser";
import type { RuntimeInfraHandler } from "./runtime-infra.browser";
import { CAPABILITIES } from "./loop-shared-types";
import type { ToolContract } from "./tool-contract-registry";
import type {
  McpDiscoveredToolInput,
  McpDiscoveredToolRecord,
} from "./mcp-registry";

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
      mode: "bridge",
      action: tool.dynamicToolName,
      verifyPolicy: "off",
    },
  };
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
    const removed = registry.removeServer(server.id);
    for (const name of removed) {
      input.orchestrator.unregisterToolContract(name);
    }
    return { serverId: server.id, toolNames: [] };
  }

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

  const payload = toRecord(invokeResult.data);
  const rawTools = Array.isArray(payload.tools)
    ? payload.tools.filter(isPlainObject)
    : [];
  const normalizedTools: McpDiscoveredToolInput[] = rawTools.map((item) => ({
    name: String(item.name || "").trim(),
    ...(typeof item.title === "string" && item.title.trim()
      ? { title: item.title.trim() }
      : {}),
    ...(typeof item.description === "string"
      ? { description: item.description.trim() }
      : {}),
    inputSchema: cloneSchema(item.inputSchema),
  }));

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
  refresh?: boolean;
}): Promise<{
  activeServerIds: string[];
  toolNames: string[];
  failures: Array<{ serverId: string; message: string }>;
}> {
  const configuredServers = normalizeMcpServerList(input.servers);
  const registry = input.orchestrator.getMcpRegistry();
  const configuredIds = new Set(configuredServers.map((item) => item.id));

  for (const existing of input.orchestrator.listMcpServers()) {
    if (configuredIds.has(existing.id)) continue;
    unregisterToolNames(input.orchestrator, registry.removeServer(existing.id));
  }

  const activeServerIds: string[] = [];
  const toolNames: string[] = [];
  const failures: Array<{ serverId: string; message: string }> = [];

  for (const server of configuredServers) {
    if (server.enabled === false) {
      unregisterToolNames(input.orchestrator, registry.removeServer(server.id));
      continue;
    }

    input.orchestrator.upsertMcpServer(server);
    try {
      const synced = await syncMcpServerTools({
        orchestrator: input.orchestrator,
        infra: input.infra,
        serverId: server.id,
        refresh: input.refresh === true,
      });
      activeServerIds.push(server.id);
      toolNames.push(...synced.toolNames);
    } catch (error) {
      unregisterToolNames(input.orchestrator, registry.removeServer(server.id));
      failures.push({
        serverId: server.id,
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
