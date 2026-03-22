export type McpTransport = "stdio" | "streamable-http";

export interface McpServerConfig {
  id: string;
  label?: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  envRef?: string;
  authRef?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cloneStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const normalized = trimString(item);
    if (!normalized) continue;
    out.push(normalized);
  }
  return out.length > 0 ? out : undefined;
}

function cloneStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = trimString(item);
    if (!normalized) continue;
    out[key] = normalized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function sanitizeMcpIdentifier(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function createMcpServerId(raw: unknown, fallback = "mcp_server"): string {
  const direct = sanitizeMcpIdentifier(raw);
  if (direct) return direct;
  const fallbackId = sanitizeMcpIdentifier(fallback);
  return fallbackId || "mcp_server";
}

function normalizeTransport(raw: unknown): McpTransport {
  return raw === "streamable-http" ? "streamable-http" : "stdio";
}

function createUniqueServerId(base: string, taken: Set<string>): string {
  let candidate = createMcpServerId(base);
  if (!candidate) candidate = "mcp_server";
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${createMcpServerId(base)}_${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

export function normalizeMcpServerConfig(
  raw: unknown,
  fallbackId = "mcp_server",
): McpServerConfig {
  const row = isPlainObject(raw) ? raw : {};
  const label = trimString(row.label);
  const seed = label || trimString(row.id) || fallbackId;
  const id = createMcpServerId(row.id, seed);
  const transport = normalizeTransport(row.transport);
  const args = cloneStringList(row.args);
  const env = cloneStringRecord(row.env);
  const headers = cloneStringRecord(row.headers);

  return {
    id,
    ...(label ? { label } : {}),
    enabled: row.enabled !== false,
    transport,
    ...(trimString(row.command) ? { command: trimString(row.command) } : {}),
    ...(args ? { args } : {}),
    ...(trimString(row.cwd) ? { cwd: trimString(row.cwd) } : {}),
    ...(env ? { env } : {}),
    ...(trimString(row.url) ? { url: trimString(row.url) } : {}),
    ...(headers ? { headers } : {}),
    ...(trimString(row.envRef) ? { envRef: trimString(row.envRef) } : {}),
    ...(trimString(row.authRef) ? { authRef: trimString(row.authRef) } : {}),
  };
}

export function normalizeMcpServerList(raw: unknown): McpServerConfig[] {
  const source = Array.isArray(raw) ? raw : [];
  const out: McpServerConfig[] = [];
  const taken = new Set<string>();

  for (let index = 0; index < source.length; index += 1) {
    const normalized = normalizeMcpServerConfig(
      source[index],
      `mcp_server_${index + 1}`,
    );
    const id = createUniqueServerId(normalized.id, taken);
    out.push({
      ...normalized,
      id,
    });
  }

  return out;
}
