export type McpTransport = "stdio" | "streamable-http";

export interface McpRefConfig {
  auth?: Record<string, string>;
  env?: Record<string, Record<string, string>>;
}

export interface McpServerConfig {
  id: string;
  label?: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  authRef?: string;
  env?: Record<string, string>;
  envRef?: string;
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

function cloneStringRecord(
  value: unknown,
  options: {
    normalizeKey?: (key: string) => string;
  } = {},
): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const baseKey = trimString(rawKey);
    if (!baseKey) continue;
    const key = options.normalizeKey ? options.normalizeKey(baseKey) : baseKey;
    if (!key) continue;
    const normalizedValue = trimString(rawValue);
    if (!normalizedValue) continue;
    out[key] = normalizedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cloneNestedStringRecord(
  value: unknown,
): Record<string, Record<string, string>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = trimString(rawKey);
    if (!key) continue;
    const normalizedValue = cloneStringRecord(rawValue);
    if (!normalizedValue) continue;
    out[key] = normalizedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function cloneHeaderRecord(value: unknown): Record<string, string> | undefined {
  return cloneStringRecord(value, {
    normalizeKey: (key) => key.toLowerCase(),
  });
}

function mergeStringRecord(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      const normalizedKey = trimString(key);
      const normalizedValue = trimString(value);
      if (!normalizedKey || !normalizedValue) continue;
      out[normalizedKey] = normalizedValue;
    }
  }
  if (override) {
    for (const [key, value] of Object.entries(override)) {
      const normalizedKey = trimString(key);
      const normalizedValue = trimString(value);
      if (!normalizedKey || !normalizedValue) continue;
      out[normalizedKey] = normalizedValue;
    }
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

  return {
    id,
    ...(label ? { label } : {}),
    enabled: row.enabled !== false,
    transport,
    ...(trimString(row.command) ? { command: trimString(row.command) } : {}),
    ...(args ? { args } : {}),
    ...(trimString(row.cwd) ? { cwd: trimString(row.cwd) } : {}),
    ...(trimString(row.url) ? { url: trimString(row.url) } : {}),
    ...(cloneHeaderRecord(row.headers) ? { headers: cloneHeaderRecord(row.headers) } : {}),
    ...(trimString(row.authRef) ? { authRef: trimString(row.authRef) } : {}),
    ...(cloneStringRecord(row.env) ? { env: cloneStringRecord(row.env) } : {}),
    ...(trimString(row.envRef) ? { envRef: trimString(row.envRef) } : {}),
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

export function normalizeMcpRefConfig(raw: unknown): McpRefConfig {
  const row = isPlainObject(raw) ? raw : {};
  return {
    ...(cloneStringRecord(row.auth) ? { auth: cloneStringRecord(row.auth) } : {}),
    ...(cloneNestedStringRecord(row.env)
      ? { env: cloneNestedStringRecord(row.env) }
      : {}),
  };
}

export function resolveMcpServerRuntimeConfig(
  server: McpServerConfig,
  refs: McpRefConfig | null | undefined,
): McpServerConfig {
  const normalizedServer = normalizeMcpServerConfig(server, server.id || "mcp_server");
  const normalizedRefs = normalizeMcpRefConfig(refs);

  const authHeaderValue =
    normalizedServer.authRef &&
    normalizedRefs.auth &&
    trimString(normalizedRefs.auth[normalizedServer.authRef]);
  const headersFromRef = authHeaderValue
    ? ({ authorization: authHeaderValue } satisfies Record<string, string>)
    : undefined;
  const resolvedHeaders = mergeStringRecord(headersFromRef, normalizedServer.headers);

  const envFromRef =
    normalizedServer.envRef && normalizedRefs.env
      ? normalizedRefs.env[normalizedServer.envRef]
      : undefined;
  const resolvedEnv = mergeStringRecord(envFromRef, normalizedServer.env);

  return {
    ...normalizedServer,
    ...(resolvedHeaders ? { headers: resolvedHeaders } : {}),
    ...(resolvedEnv ? { env: resolvedEnv } : {}),
  };
}
