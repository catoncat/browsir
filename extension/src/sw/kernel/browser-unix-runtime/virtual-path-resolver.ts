export type NamespaceScope = "ephemeral" | "global" | "session";

export interface VirtualNamespaceDescriptor {
  key: string;
  scope: NamespaceScope;
  unixRoot: string;
}

export interface ResolvedVirtualPath {
  uri: string;
  scheme: "mem";
  path: string;
  unixPath: string;
  relativePath: string;
  namespace: VirtualNamespaceDescriptor;
}

const SESSION_ROOT = "/sessions";
const GLOBAL_ROOT = "/globals";
const DEFAULT_SESSION_ID = "default";
export const VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX = "virtualfs:namespace:";
export const SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}session:`;
const GLOBAL_SKILLS_NAMESPACE_KEY =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}global:skills`;
const GLOBAL_PLUGINS_NAMESPACE_KEY =
  `${VIRTUAL_NAMESPACE_STORAGE_KEY_PREFIX}global:plugins`;

export function normalizeSessionSegment(raw: unknown): string {
  const text = String(raw || "").trim();
  const source = text || "default";
  return source.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toNamespaceStorageKey(input: unknown): string {
  return String(input || "").trim();
}

export function parseVirtualUri(
  input: unknown,
  defaultScheme: "mem" = "mem"
): { uri: string; scheme: "mem"; path: string } {
  let text = String(input || "").trim();
  if (!text || text === "." || text === "/") {
    text = `${defaultScheme}://`;
  }

  if (/^vfs:\/\//i.test(text)) {
    throw new Error("browser unix sandbox 仅支持 mem:// 路径");
  }

  const direct = /^mem:\/\/(.*)$/i.exec(text);
  const mounted = /^\/mem(?:\/(.*))?$/i.exec(text);
  let rest = "";
  if (direct) {
    rest = String(direct[1] || "");
  } else if (mounted) {
    rest = String(mounted[1] || "");
  } else {
    rest = text;
  }

  rest = rest.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
  if (rest.length > 1) rest = rest.replace(/\/+$/, "");
  return {
    uri: `mem://${rest}`,
    scheme: "mem",
    path: rest
  };
}

export function normalizeRelativePath(path: string): string {
  const segments = String(path || "")
    .split("/")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) {
        throw new Error("virtual path 越界：不允许访问 session 根目录之外");
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/");
}

export function buildSessionNamespaceStorageKey(sessionId: string): string {
  return `${SESSION_VIRTUAL_NAMESPACE_KEY_PREFIX}${normalizeSessionSegment(
    sessionId || DEFAULT_SESSION_ID
  )}`;
}

export function buildSystemNamespaceStorageKey(sessionId: string): string {
  return `ephemeral:${normalizeSessionSegment(sessionId)}:__bbl`;
}

export function sessionUnixRoot(sessionId: string): string {
  return `${SESSION_ROOT}/${normalizeSessionSegment(sessionId)}/mem`;
}

export function systemUnixRoot(sessionId: string): string {
  return `${SESSION_ROOT}/${normalizeSessionSegment(sessionId)}/__bbl`;
}

export function createSessionNamespace(sessionId: string): VirtualNamespaceDescriptor {
  return {
    key: buildSessionNamespaceStorageKey(sessionId),
    scope: "session",
    unixRoot: sessionUnixRoot(sessionId)
  };
}

export function createSkillsNamespace(): VirtualNamespaceDescriptor {
  return {
    key: GLOBAL_SKILLS_NAMESPACE_KEY,
    scope: "global",
    unixRoot: `${GLOBAL_ROOT}/skills/mem`
  };
}

export function createPluginsNamespace(): VirtualNamespaceDescriptor {
  return {
    key: GLOBAL_PLUGINS_NAMESPACE_KEY,
    scope: "global",
    unixRoot: `${GLOBAL_ROOT}/plugins/mem`
  };
}

export function createSystemNamespace(sessionId: string): VirtualNamespaceDescriptor {
  return {
    key: buildSystemNamespaceStorageKey(sessionId),
    scope: "ephemeral",
    unixRoot: systemUnixRoot(sessionId)
  };
}

export function listNamespaceDescriptors(sessionId: string): VirtualNamespaceDescriptor[] {
  return [
    createSessionNamespace(sessionId),
    createSkillsNamespace(),
    createPluginsNamespace(),
    createSystemNamespace(sessionId)
  ];
}

export function resolveVirtualPath(input: unknown, sessionId: string): ResolvedVirtualPath {
  const parsed = parseVirtualUri(input);
  const rawPath = String(parsed.path || "");
  if (/(?:^|\/)\.\.[\/]?/.test(rawPath)) {
    normalizeRelativePath(rawPath);
  }
  const rawSegments = rawPath
    .split("/")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const firstSegment = rawSegments[0] || "";
  let namespace = createSessionNamespace(sessionId);
  let relativeSource = parsed.path;
  let normalizedPath = normalizeRelativePath(parsed.path);
  if (firstSegment === "skills") {
    namespace = createSkillsNamespace();
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  } else if (firstSegment === "plugins") {
    namespace = createPluginsNamespace();
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  } else if (firstSegment === "__bbl") {
    namespace = createSystemNamespace(sessionId);
    relativeSource = rawSegments.slice(1).join("/");
    normalizedPath = [firstSegment, normalizeRelativePath(relativeSource)]
      .filter(Boolean)
      .join("/");
  }
  const relativePath = normalizeRelativePath(relativeSource);
  const unixPath = relativePath
    ? `${namespace.unixRoot}/${relativePath}`
    : namespace.unixRoot;
  return {
    ...parsed,
    uri: `mem://${normalizedPath}`,
    path: normalizedPath,
    unixPath,
    relativePath,
    namespace
  };
}

export function dirname(path: string): string {
  const normalized = String(path || "").replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

export function rewriteCommandVirtualUris(command: string, sessionId: string): string {
  return command.replace(
    /(^|[\s"'`(|;&])((?:mem:\/\/|\/mem(?:\/|$))[^\s"'`|;&)]*)/gi,
    (_match, prefix: string, rawPath: string) => {
      return `${prefix}${resolveVirtualPath(rawPath, sessionId).unixPath}`;
    }
  );
}

export function unixPathToVirtualUri(
  unixPath: unknown,
  sessionId: string
): string {
  const normalized = String(unixPath || "").trim().replace(/\/+$/, "");
  const current = normalized || "/";
  const sessionRoot = sessionUnixRoot(sessionId).replace(/\/+$/, "");
  const skillsRoot = createSkillsNamespace().unixRoot.replace(/\/+$/, "");
  const pluginsRoot = createPluginsNamespace().unixRoot.replace(/\/+$/, "");
  const systemRoot = systemUnixRoot(sessionId).replace(/\/+$/, "");

  const toUri = (root: string, prefix: string): string | null => {
    if (current === root) return prefix;
    if (!current.startsWith(`${root}/`)) return null;
    const relative = current.slice(root.length + 1);
    if (!relative) return prefix;
    if (prefix.endsWith("://")) {
      return `${prefix}${relative}`;
    }
    return `${prefix}/${relative}`;
  };

  return (
    toUri(sessionRoot, "mem://") ??
    toUri(skillsRoot, "mem://skills") ??
    toUri(pluginsRoot, "mem://plugins") ??
    toUri(systemRoot, "mem://__bbl") ??
    current
  );
}
