export type McpTransport = "stdio" | "streamable-http";

export interface McpServerConfig {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  authRef?: string;
  envRef?: string;
}

export interface NormalizedMcpServerConfig {
  id: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface McpDiscoveredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpListToolsResult {
  serverId: string;
  transport: McpTransport;
  tools: McpDiscoveredTool[];
}

export interface McpCallToolResult {
  serverId: string;
  toolName: string;
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
  _meta?: Record<string, unknown>;
}
