import { mcpClientRegistry } from "../mcp/client-registry";

export async function runMcpListTools(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await mcpClientRegistry.listTools(args.server, {
    refresh: args.refresh === true,
  });
  return {
    serverId: result.serverId,
    transport: result.transport,
    tools: result.tools,
  };
}

export async function runMcpCallTool(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await mcpClientRegistry.callTool({
    server: args.server,
    toolName: args.toolName,
    arguments: args.arguments,
  });
  return {
    serverId: result.serverId,
    toolName: result.toolName,
    content: result.content,
    structuredContent: result.structuredContent,
    isError: result.isError,
    _meta: result._meta,
  };
}

export async function runMcpDisconnectServer(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const closed = await mcpClientRegistry.closeServer(args.serverId);
  return {
    serverId: String(args.serverId || "").trim(),
    closed,
  };
}
