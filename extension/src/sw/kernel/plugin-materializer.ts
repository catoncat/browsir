import {
  clonePersistableRecord,
  upsertPersistedPluginRecord,
  type PersistedPluginRecord,
} from "./runtime-router/plugin-persistence";
import {
  PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
  buildPluginVirtualSourcePaths,
  invokePluginSandboxRunner,
  writeVirtualTextFile,
} from "./runtime-router/plugin-sandbox";
import { isVirtualUri } from "./virtual-fs.browser";
import { serializeValueToModuleSource } from "./plugin-module-serializer";
import type {
  AgentPluginManifest,
  AgentPluginPermissions,
} from "./plugin-runtime";
import { nowIso } from "./types";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.length > 0 ? out : [];
}

function toSafeVirtualSegment(input: unknown): string {
  const text = String(input || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  return text || "plugin";
}

function buildPluginScopedVirtualSourcePaths(
  rootBase: string,
  pluginId: string,
): {
  root: string;
  packagePath: string;
  indexPath: string;
  uiPath: string;
} {
  const segment = toSafeVirtualSegment(pluginId);
  const normalizedRootBase = String(rootBase || "mem://plugins").trim().replace(
    /\/+$/g,
    "",
  );
  const root = `${normalizedRootBase}/${segment}`;
  return {
    root,
    packagePath: `${root}/plugin.json`,
    indexPath: `${root}/index.js`,
    uiPath: `${root}/ui.js`,
  };
}

function buildPluginValidationVirtualSourcePaths(pluginId: string): {
  root: string;
  packagePath: string;
  indexPath: string;
  uiPath: string;
} {
  return buildPluginScopedVirtualSourcePaths(
    "mem://__bbl/plugin-validate",
    pluginId,
  );
}

async function validateMaterializedPluginModule(input: {
  modulePath: string;
  exportName: string;
  sessionId: string;
}): Promise<void> {
  await invokePluginSandboxRunner({
    sessionId: input.sessionId,
    modulePath: input.modulePath,
    exportName: input.exportName,
    op: "describe",
  });
}

function normalizePluginPermissions(input: unknown): AgentPluginPermissions {
  const row = toRecord(input);
  const hooks = toStringList(row.hooks);
  const modesRaw = toStringList(row.modes);
  const capabilities = toStringList(row.capabilities);
  const tools = toStringList(row.tools);
  const llmProviders = toStringList(row.llmProviders);
  const runtimeMessages = toStringList(row.runtimeMessages);
  const brainEvents = toStringList(row.brainEvents);
  const modes =
    Array.isArray(modesRaw) && modesRaw.length > 0
      ? (modesRaw.filter(
          (item) => item === "script" || item === "cdp" || item === "bridge",
        ) as Array<"script" | "cdp" | "bridge">)
      : undefined;
  return {
    ...(hooks ? { hooks } : {}),
    ...(modes ? { modes } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(tools ? { tools } : {}),
    ...(llmProviders ? { llmProviders } : {}),
    ...(runtimeMessages ? { runtimeMessages } : {}),
    ...(brainEvents ? { brainEvents } : {}),
    ...(row.replaceProviders === true ? { replaceProviders: true } : {}),
    ...(row.replaceToolContracts === true
      ? { replaceToolContracts: true }
      : {}),
    ...(row.replaceLlmProviders === true ? { replaceLlmProviders: true } : {}),
  };
}

function buildPersistedExtensionSource(
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const source: Record<string, unknown> = {};
  const manifest = clonePersistableRecord(toRecord(input.manifest));
  if (!manifest || Object.keys(manifest).length === 0) {
    return null;
  }
  source.manifest = manifest;
  const copyFields = [
    "moduleUrl",
    "modulePath",
    "module",
    "exportName",
    "moduleSessionId",
    "sessionId",
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined) continue;
    source[key] = value;
  }
  return source;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function normalizePluginManifest(input: unknown): AgentPluginManifest {
  const row = toRecord(input);
  const id = String(row.id || "").trim();
  if (!id) throw new Error("plugin.manifest.id 不能为空");
  const name = String(row.name || "").trim() || id;
  const version = String(row.version || "").trim() || "0.0.0";
  const timeoutRaw = Number(row.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.max(50, Math.min(10_000, Math.floor(timeoutRaw)))
    : undefined;
  const permissions = normalizePluginPermissions(row.permissions);
  return {
    id,
    name,
    version,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
  };
}

export async function materializeExtensionFactoryPluginSource(
  source: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const manifest = normalizePluginManifest(source.manifest);
  const setup = source.setup;
  if (typeof setup !== "function") {
    throw new Error("plugin.setup 必须是函数");
  }
  const paths = buildPluginVirtualSourcePaths(manifest.id);
  const moduleSessionId =
    String(
      source.moduleSessionId ||
        source.sessionId ||
        PLUGIN_SANDBOX_DEFAULT_SESSION_ID,
    ).trim() || PLUGIN_SANDBOX_DEFAULT_SESSION_ID;
  const moduleSource = `module.exports = ${serializeValueToModuleSource(
    setup,
    "setup",
  )};`;
  await writeVirtualTextFile(paths.indexPath, moduleSource, moduleSessionId);
  const next: Record<string, unknown> = {
    manifest,
    modulePath: paths.indexPath,
    exportName: "default",
    moduleSessionId,
  };
  const copyFields = [
    "uiModuleUrl",
    "uiModulePath",
    "uiModule",
    "uiExportName",
    "uiModuleSessionId",
    "sessionId",
  ] as const;
  for (const key of copyFields) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    next[key] = value;
  }
  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    moduleSessionId,
  );
  await validateMaterializedPluginModule({
    modulePath: paths.indexPath,
    exportName: "default",
    sessionId: moduleSessionId,
  });
  return next;
}

export async function materializeInlinePluginSources(
  source: Record<string, unknown>,
  sessionId: string,
  options: { transient?: boolean } = {},
): Promise<Record<string, unknown>> {
  const manifest = toRecord(source.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!pluginId) return source;

  const indexJs = String(source.indexJs || "").trim();
  const uiJs = String(source.uiJs || "").trim();
  if (!indexJs && !uiJs) return source;

  const paths = options.transient
    ? buildPluginValidationVirtualSourcePaths(pluginId)
    : buildPluginVirtualSourcePaths(pluginId);
  const next: Record<string, unknown> = {
    ...source,
  };
  const existingModulePath = String(
    source.modulePath || source.moduleUrl || source.module || "",
  ).trim();

  if (indexJs) {
    const modulePath = (existingModulePath && isVirtualUri(existingModulePath))
      ? existingModulePath
      : paths.indexPath;
    await writeVirtualTextFile(modulePath, indexJs, sessionId);
    next.modulePath = modulePath;
    next.moduleSessionId = sessionId;
  }

  if (uiJs) {
    const existingUiModulePath =
      String(
        source.uiModulePath || source.uiModuleUrl || source.uiModule || "",
      ).trim();
    const uiModulePath = (existingUiModulePath && isVirtualUri(existingUiModulePath))
      ? existingUiModulePath
      : paths.uiPath;
    await writeVirtualTextFile(uiModulePath, uiJs, sessionId);
    next.uiModulePath = uiModulePath;
    next.uiModuleSessionId = sessionId;
  }

  await writeVirtualTextFile(
    paths.packagePath,
    JSON.stringify(next, null, 2),
    sessionId,
  );
  return next;
}

export async function persistExtensionPluginRegistration(
  source: Record<string, unknown>,
  enabled: boolean,
): Promise<PersistedPluginRecord | null> {
  const persistable = buildPersistedExtensionSource(source);
  const manifest = toRecord(persistable?.manifest);
  const pluginId = String(manifest.id || "").trim();
  if (!persistable || !pluginId) return null;
  return upsertPersistedPluginRecord({
    pluginId,
    kind: "extension",
    enabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    source: persistable,
  });
}

export function hasPluginExtensionEntry(
  source: Record<string, unknown>,
): boolean {
  return (
    typeof source.setup === "function" ||
    String(source.moduleUrl || "").trim().length > 0 ||
    String(source.modulePath || "").trim().length > 0 ||
    String(source.module || "").trim().length > 0
  );
}
