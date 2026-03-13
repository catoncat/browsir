import type { ExtensionFactory } from "../extension-api";
import { isVirtualUri } from "../virtual-fs.browser";
import { nowIso } from "../types";

const UI_EXTENSION_STORAGE_KEY = "brain.plugin.ui_extensions";
const RUNTIME_ROUTER_MODULE_URL = new URL("../runtime-router.ts", import.meta.url);

export interface UiExtensionDescriptor {
  pluginId: string;
  moduleUrl: string;
  exportName: string;
  enabled: boolean;
  updatedAt: string;
  sessionId?: string;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeUiExtensionDescriptor(
  input: unknown,
): UiExtensionDescriptor | null {
  const row = toRecord(input);
  const pluginId = String(row.pluginId || "").trim();
  const moduleUrl = String(row.moduleUrl || "").trim();
  if (!pluginId || !moduleUrl) return null;
  const exportName = String(row.exportName || "default").trim() || "default";
  const enabled = row.enabled !== false;
  const updatedAt = String(row.updatedAt || "").trim() || nowIso();
  return {
    pluginId,
    moduleUrl,
    exportName,
    enabled,
    updatedAt,
    sessionId: String(row.sessionId || "").trim() || undefined,
  };
}

export async function readUiExtensionDescriptors(): Promise<
  UiExtensionDescriptor[]
> {
  const payload = await chrome.storage.local.get(UI_EXTENSION_STORAGE_KEY);
  const list = Array.isArray(toRecord(payload)[UI_EXTENSION_STORAGE_KEY])
    ? (toRecord(payload)[UI_EXTENSION_STORAGE_KEY] as unknown[])
    : [];
  const out: UiExtensionDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const normalized = normalizeUiExtensionDescriptor(item);
    if (!normalized) continue;
    if (seen.has(normalized.pluginId)) continue;
    seen.add(normalized.pluginId);
    out.push(normalized);
  }
  return out;
}

async function writeUiExtensionDescriptors(
  list: UiExtensionDescriptor[],
): Promise<void> {
  await chrome.storage.local.set({
    [UI_EXTENSION_STORAGE_KEY]: list,
  });
}

export async function upsertUiExtensionDescriptor(
  next: UiExtensionDescriptor,
): Promise<void> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === next.pluginId);
  if (index >= 0) {
    list[index] = next;
  } else {
    list.push(next);
  }
  await writeUiExtensionDescriptors(list);
}

export async function updateUiExtensionDescriptorEnabled(
  pluginId: string,
  enabled: boolean,
): Promise<UiExtensionDescriptor | null> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === pluginId);
  if (index < 0) return null;
  const next = {
    ...list[index],
    enabled,
    updatedAt: nowIso(),
  };
  list[index] = next;
  await writeUiExtensionDescriptors(list);
  return next;
}

export async function removeUiExtensionDescriptor(
  pluginId: string,
): Promise<UiExtensionDescriptor | null> {
  const list = await readUiExtensionDescriptors();
  const index = list.findIndex((item) => item.pluginId === pluginId);
  if (index < 0) return null;
  const [removed] = list.splice(index, 1);
  await writeUiExtensionDescriptors(list);
  return removed || null;
}

export async function pruneUiExtensionDescriptors(
  pluginIds: Iterable<string>,
): Promise<void> {
  const allowed = new Set<string>();
  for (const pluginId of pluginIds) {
    const id = String(pluginId || "").trim();
    if (!id) continue;
    allowed.add(id);
  }
  const list = await readUiExtensionDescriptors();
  const next = list.filter((item) => allowed.has(item.pluginId));
  if (next.length === list.length) return;
  await writeUiExtensionDescriptors(next);
}

export function notifyUiExtensionLifecycle(
  type:
    | "brain.plugin.ui_extension.registered"
    | "brain.plugin.ui_extension.enabled"
    | "brain.plugin.ui_extension.disabled"
    | "brain.plugin.ui_extension.unregistered",
  descriptor: UiExtensionDescriptor,
): void {
  try {
    const maybePromise = chrome.runtime.sendMessage({
      type,
      payload: descriptor,
    });
    if (
      maybePromise &&
      typeof (maybePromise as Promise<unknown>).catch === "function"
    ) {
      void (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

export function resolvePluginModuleUrl(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("plugin extension moduleUrl 不能为空");
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
  if (raw.startsWith("//")) {
    throw new Error(`plugin extension moduleUrl 非法: ${raw}`);
  }
  const normalized = raw.startsWith("/") ? raw.slice(1) : raw;
  const chromeRuntime = (
    globalThis as typeof globalThis & {
      chrome?: {
        runtime?: {
          getURL?: (path: string) => string;
        };
      };
    }
  ).chrome?.runtime;
  if (chromeRuntime?.getURL) {
    return chromeRuntime.getURL(normalized);
  }
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return new URL(raw, RUNTIME_ROUTER_MODULE_URL).href;
  }
  return new URL(`../../../${normalized}`, RUNTIME_ROUTER_MODULE_URL).href;
}

export async function loadExtensionFactoryFromModule(
  moduleUrl: string,
  exportName = "default",
): Promise<ExtensionFactory> {
  const moduleNs = (await import(/* @vite-ignore */ moduleUrl)) as Record<
    string,
    unknown
  >;
  const target = String(exportName || "default").trim() || "default";
  const setup = target === "default" ? moduleNs.default : moduleNs[target];
  if (typeof setup !== "function") {
    throw new Error(`plugin extension ${moduleUrl} 缺少可执行导出: ${target}`);
  }
  return setup as ExtensionFactory;
}

export function resolveUiExtensionDescriptorFromSource(
  pluginId: string,
  source: Record<string, unknown>,
  enabled: boolean,
  defaultSessionId: string,
): UiExtensionDescriptor | null {
  const moduleInput =
    source.uiModuleUrl ?? source.uiModulePath ?? source.uiModule;
  const hasModule =
    String(source.uiModuleUrl || "").trim().length > 0 ||
    String(source.uiModulePath || "").trim().length > 0 ||
    String(source.uiModule || "").trim().length > 0;
  if (!hasModule) return null;
  const moduleUrl = resolvePluginModuleUrl(moduleInput);
  const exportName =
    String(source.uiExportName || "default").trim() || "default";
  const sessionId = String(
    source.uiModuleSessionId ||
      source.moduleSessionId ||
      source.sessionId ||
      defaultSessionId,
  ).trim();
  return {
    pluginId,
    moduleUrl,
    exportName,
    enabled,
    updatedAt: nowIso(),
    ...(isVirtualUri(moduleUrl)
      ? { sessionId: sessionId || defaultSessionId }
      : {}),
  };
}
