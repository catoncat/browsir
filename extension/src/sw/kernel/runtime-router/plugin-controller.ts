import { registerExtension, type ExtensionFactory } from "../extension-api";
import type { BrainOrchestrator } from "../orchestrator.browser";
import type {
  AgentPluginDefinition,
  AgentPluginManifest,
} from "../plugin-runtime";
import { isVirtualUri } from "../virtual-fs.browser";
import {
  clonePersistableRecord,
  type PersistedPluginRecord,
  readPersistedPluginRecords,
  removePersistedPluginRecord,
  seedDefaultExamplePluginRecords,
  updatePersistedPluginEnabled,
} from "./plugin-persistence";
import {
  loadExtensionFactoryFromModule,
  notifyUiExtensionLifecycle,
  pruneUiExtensionDescriptors,
  readUiExtensionDescriptors,
  removeUiExtensionDescriptor,
  resolvePluginModuleUrl,
  resolveUiExtensionDescriptorFromSource,
  updateUiExtensionDescriptorEnabled,
  upsertUiExtensionDescriptor,
} from "./plugin-ui-extensions";
import { recordRuntimeInternalDebugEvent } from "./runtime-debug-store";

type RuntimeOk<T = unknown> = {
  ok: true;
  data: T;
};

type RuntimeErr = {
  ok: false;
  error: string;
};

export type PluginControllerResult<T = unknown> = RuntimeOk<T> | RuntimeErr;

type PluginSandboxRunnerOp = "describe" | "runHook";

interface PluginSandboxRunnerInput {
  sessionId: string;
  modulePath: string;
  exportName: string;
  op: PluginSandboxRunnerOp;
  hook?: string;
  payload?: unknown;
}

export interface PluginControllerDeps {
  builtinPluginIdPrefix: string;
  pluginSandboxDefaultSessionId: string;
  cleanupPluginVirtualArtifacts(
    pluginId: string,
    sessionId: string,
  ): Promise<void>;
  emitPluginHookTrace(payload: Record<string, unknown>): void;
  emitPluginRuntimeMessage(message: unknown): void;
  hasPluginExtensionEntry(source: Record<string, unknown>): boolean;
  invokePluginSandboxRunner(
    input: PluginSandboxRunnerInput,
  ): Promise<Record<string, unknown>>;
  loadExtensionFactoryFromVirtualModule(input: {
    manifest: AgentPluginManifest;
    modulePath: string;
    exportName: string;
    sessionId: string;
  }): Promise<ExtensionFactory>;
  materializeExtensionFactoryPluginSource(
    source: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  materializeInlinePluginSources(
    source: Record<string, unknown>,
    sessionId: string,
    options?: { transient?: boolean },
  ): Promise<Record<string, unknown>>;
  normalizePluginManifest(input: unknown): AgentPluginManifest;
  persistExtensionPluginRegistration(
    source: Record<string, unknown>,
    enabled: boolean,
  ): Promise<PersistedPluginRecord | null>;
  previewJsonText(value: unknown, max?: number): string;
  readVirtualJsonObject(
    path: string,
    field: string,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
}

interface PluginValidationCheck {
  name: string;
  ok: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

interface RegisterPluginOptions {
  replace: boolean;
  enable: boolean;
}

function ok<T>(data: T): PluginControllerResult<T> {
  return { ok: true, data };
}

function fail(error: unknown): PluginControllerResult {
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: String(error) };
}

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

function buildPluginValidationCheck(
  name: string,
  passed: boolean,
  options: { error?: unknown; details?: Record<string, unknown> } = {},
): PluginValidationCheck {
  return {
    name,
    ok: passed,
    ...(passed
      ? {}
      : {
          error: String(options.error || "").trim() || "校验失败",
        }),
    ...(options.details && Object.keys(options.details).length > 0
      ? { details: options.details }
      : {}),
  };
}

function readPluginInstallSource(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(input, "plugin")) {
    throw new Error(
      "brain.plugin.install package.plugin 已移除；请直接传插件包 object",
    );
  }
  return input;
}

function validatePluginInstallSource(source: Record<string, unknown>): void {
  const manifest = toRecord(source.manifest);
  const manifestId = String(manifest.id || "").trim();
  if (!manifestId) {
    throw new Error("brain.plugin.install package manifest.id 不能为空");
  }
}

function readPluginId(payload: Record<string, unknown>): string {
  return String(payload.pluginId || payload.id || "").trim();
}

function isBuiltinPluginId(pluginId: string, prefix: string): boolean {
  return String(pluginId || "")
    .trim()
    .startsWith(prefix);
}

function resolvePluginRegisterOptions(
  source: Record<string, unknown>,
  payload: Record<string, unknown>,
): RegisterPluginOptions {
  const replaceRaw = source.replace ?? payload.replace;
  const enableRaw = source.enable ?? payload.enable;
  return {
    replace: replaceRaw === true,
    enable: enableRaw === false ? false : true,
  };
}

async function rehydratePersistedPluginRecord(
  orchestrator: BrainOrchestrator,
  record: PersistedPluginRecord,
  deps: PluginControllerDeps,
): Promise<void> {
  if (record.kind === "builtin_state") {
    if (record.enabled) {
      orchestrator.enablePlugin(record.pluginId);
    } else {
      orchestrator.disablePlugin(record.pluginId);
    }
    return;
  }

  const source = clonePersistableRecord(record.source);
  if (!source || typeof source !== "object") {
    throw new Error(`persisted plugin source 非法: ${record.pluginId}`);
  }

  const message =
    {
      ...source,
      type: "brain.plugin.register_extension",
      __pluginPersistenceHydrate: true,
      replace: true,
      enable: record.enabled,
    } as Record<string, unknown>;
  const result = await handleBrainPlugin(orchestrator, message, deps);
  if (!result.ok) {
    throw new Error(String(result.error || "plugin rehydrate failed"));
  }
}

export async function rehydratePersistedPlugins(
  orchestrator: BrainOrchestrator,
  deps: PluginControllerDeps,
): Promise<void> {
  await seedDefaultExamplePluginRecords();
  const records = await readPersistedPluginRecords();
  const ordered = [
    ...records.filter((item) => item.kind !== "builtin_state"),
    ...records.filter((item) => item.kind === "builtin_state"),
  ];
  for (const record of ordered) {
    try {
      await rehydratePersistedPluginRecord(orchestrator, record, deps);
      recordRuntimeInternalDebugEvent({
        ts: new Date().toISOString(),
        type: "plugin.rehydrate.applied",
        ok: true,
        pluginId: record.pluginId,
        detail: record.kind,
      });
    } catch (error) {
      recordRuntimeInternalDebugEvent({
        ts: new Date().toISOString(),
        type: "plugin.rehydrate.failed",
        ok: false,
        pluginId: record.pluginId,
        detail: error instanceof Error ? error.message : String(error),
      });
      console.warn(
        `[runtime-router] plugin rehydrate failed: ${record.pluginId}`,
        error,
      );
    }
  }
  await pruneUiExtensionDescriptors(
    orchestrator.listPlugins().map((item) => String(item.id || "").trim()),
  );
}

export async function handleBrainPlugin(
  orchestrator: BrainOrchestrator,
  message: unknown,
  deps: PluginControllerDeps,
): Promise<PluginControllerResult> {
  const payload = toRecord(message);
  const action = String(payload.type || "");
  const isPluginPersistenceHydrate =
    payload.__pluginPersistenceHydrate === true;

  if (action === "brain.plugin.list") {
    const uiExtensions = await readUiExtensionDescriptors();
    return ok({
      plugins: orchestrator.listPlugins(),
      modeProviders: orchestrator.listToolProviders(),
      toolContracts: orchestrator.listToolContracts(),
      llmProviders: orchestrator.listLlmProviders(),
      capabilityProviders: orchestrator.listCapabilityProviders(),
      capabilityPolicies: orchestrator.listCapabilityPolicies(),
      uiExtensions,
    });
  }

  if (action === "brain.plugin.ui_extension.list") {
    return ok({
      uiExtensions: await readUiExtensionDescriptors(),
    });
  }

  if (action === "brain.plugin.ui_hook.run") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.ui_hook.run 需要 pluginId");
    const hook = String(payload.hook || "").trim();
    if (!hook) return fail("brain.plugin.ui_hook.run 需要 hook");

    const descriptor =
      (await readUiExtensionDescriptors()).find(
        (item) => item.pluginId === pluginId,
      ) || null;
    if (!descriptor) {
      return fail(`ui extension 不存在: ${pluginId}`);
    }
    if (descriptor.enabled !== true) {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "continue",
        },
        skipped: "disabled",
      });
    }
    if (!isVirtualUri(descriptor.moduleUrl)) {
      return fail(
        `ui hook sandbox 仅支持 mem:// module: ${descriptor.moduleUrl}`,
      );
    }

    const sessionId =
      String(payload.sessionId || descriptor.sessionId || "").trim() ||
      deps.pluginSandboxDefaultSessionId;
    const exportName =
      String(payload.exportName || descriptor.exportName || "default").trim() ||
      "default";
    const startedAt = Date.now();
    let executed: Record<string, unknown>;
    try {
      executed = await deps.invokePluginSandboxRunner({
        sessionId,
        modulePath: descriptor.moduleUrl,
        exportName,
        op: "runHook",
        hook,
        payload: payload.payload,
      });
    } catch (error) {
      deps.emitPluginHookTrace({
        traceType: "ui_hook",
        pluginId,
        hook,
        modulePath: descriptor.moduleUrl,
        exportName,
        sessionId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
        requestPreview: deps.previewJsonText(payload.payload),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const runtimeMessages = Array.isArray(executed.runtimeMessages)
      ? executed.runtimeMessages
      : [];
    for (const runtimeMessage of runtimeMessages) {
      deps.emitPluginRuntimeMessage(runtimeMessage);
    }
    const hookResult = toRecord(executed.hookResult);
    deps.emitPluginHookTrace({
      traceType: "ui_hook",
      pluginId,
      hook,
      modulePath: descriptor.moduleUrl,
      exportName,
      sessionId,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      requestPreview: deps.previewJsonText(payload.payload),
      responsePreview: deps.previewJsonText(hookResult),
      runtimeMessageCount: runtimeMessages.length,
    });
    const actionName = String(hookResult.action || "").trim();
    if (actionName === "patch") {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "patch",
          patch: toRecord(hookResult.patch),
        },
      });
    }
    if (actionName === "block") {
      return ok({
        pluginId,
        hook,
        hookResult: {
          action: "block",
          reason: String(hookResult.reason || "").trim() || undefined,
        },
      });
    }
    return ok({
      pluginId,
      hook,
      hookResult: {
        action: "continue",
      },
    });
  }

  if (action === "brain.plugin.register_extension") {
    const pluginRaw = toRecord(payload.plugin);
    const source = Object.keys(pluginRaw).length > 0 ? pluginRaw : payload;
    const manifest = deps.normalizePluginManifest(source.manifest);
    const options = resolvePluginRegisterOptions(source, payload);
    const pluginId = manifest.id;
    const uiDescriptor = resolveUiExtensionDescriptorFromSource(
      pluginId,
      source,
      options.enable,
      deps.pluginSandboxDefaultSessionId,
    );
    const setupRaw = source.setup;
    const moduleInput = source.moduleUrl ?? source.modulePath ?? source.module;
    const exportName =
      String(source.exportName || "default").trim() || "default";
    const moduleSessionId =
      String(source.moduleSessionId || source.sessionId || "").trim() ||
      deps.pluginSandboxDefaultSessionId;
    const moduleSource = String(source.moduleSource || "").trim();
    if (moduleSource) {
      return fail(
        "moduleSource 暂不支持（CSP 禁止 unsafe-eval），请使用 moduleUrl/modulePath",
      );
    }

    let setup: ExtensionFactory;
    let moduleUrl = "";
    if (typeof setupRaw === "function") {
      setup = setupRaw as ExtensionFactory;
    } else {
      const rawModulePath = String(moduleInput || "").trim();
      if (!rawModulePath) {
        if (!uiDescriptor) {
          return fail(
            "brain.plugin.register_extension 需要 index 模块或 ui 模块入口",
          );
        }
        setup = () => undefined;
      } else {
        moduleUrl = resolvePluginModuleUrl(moduleInput);
        if (isVirtualUri(rawModulePath) || isVirtualUri(moduleUrl)) {
          const virtualModulePath = isVirtualUri(rawModulePath)
            ? rawModulePath
            : moduleUrl;
          setup = await deps.loadExtensionFactoryFromVirtualModule({
            manifest,
            modulePath: virtualModulePath,
            exportName,
            sessionId: moduleSessionId,
          });
          moduleUrl = virtualModulePath;
        } else {
          setup = await loadExtensionFactoryFromModule(moduleUrl, exportName);
        }
      }
    }

    registerExtension(orchestrator, manifest, setup, options);
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const persistedUiDescriptor = uiDescriptor
      ? {
          ...uiDescriptor,
          enabled: current?.enabled === true,
        }
      : null;
    try {
      if (!isPluginPersistenceHydrate) {
        const persistenceSourceBase = {
          ...source,
          manifest,
          moduleUrl,
          exportName,
          ...(isVirtualUri(moduleUrl) ? { moduleSessionId } : {}),
          ...(persistedUiDescriptor
            ? {
                uiModuleUrl: persistedUiDescriptor.moduleUrl,
                uiExportName: persistedUiDescriptor.exportName,
                ...(persistedUiDescriptor.sessionId
                  ? { uiModuleSessionId: persistedUiDescriptor.sessionId }
                  : {}),
              }
            : {}),
        } as Record<string, unknown>;
        const persistenceSource =
          typeof setupRaw === "function" && !String(moduleUrl || "").trim()
            ? await deps.materializeExtensionFactoryPluginSource(
                persistenceSourceBase,
              )
            : persistenceSourceBase;
        const persisted = await deps.persistExtensionPluginRegistration(
          persistenceSource,
          current?.enabled === true,
        );
        if (!persisted) {
          throw new Error(`plugin 持久化失败: ${pluginId}`);
        }
      }
      if (persistedUiDescriptor) {
        await upsertUiExtensionDescriptor(persistedUiDescriptor);
        if (!isPluginPersistenceHydrate) {
          notifyUiExtensionLifecycle(
            "brain.plugin.ui_extension.registered",
            persistedUiDescriptor,
          );
        }
      }
    } catch (error) {
      orchestrator.unregisterPlugin(pluginId);
      if (persistedUiDescriptor) {
        await removeUiExtensionDescriptor(pluginId).catch(() => null);
      }
      if (!isPluginPersistenceHydrate) {
        await removePersistedPluginRecord(pluginId).catch(() => false);
      }
      await deps.cleanupPluginVirtualArtifacts(
        pluginId,
        moduleSessionId,
      ).catch(() => undefined);
      return fail(error);
    }
    return ok({
      pluginId,
      enabled: current?.enabled === true,
      plugin: current,
      moduleUrl,
      exportName,
      llmProviders: orchestrator.listLlmProviders(),
      ...(persistedUiDescriptor ? { uiExtension: persistedUiDescriptor } : {}),
    });
  }

  if (action === "brain.plugin.register") {
    return fail(
      "brain.plugin.register 已移除；请使用 brain.plugin.register_extension 或 brain.plugin.install",
    );
  }

  if (action === "brain.plugin.validate") {
    const location = String(payload.location || payload.path || "").trim();
    const hasInlinePackage = Object.prototype.hasOwnProperty.call(
      payload,
      "package",
    );
    const packageFromPayload = toRecord(payload.package);
    if (hasInlinePackage && Object.keys(packageFromPayload).length === 0) {
      return fail("brain.plugin.validate 的 package 必须是 object");
    }
    const sessionId = String(payload.sessionId || "").trim() || "default";
    const packageSource =
      Object.keys(packageFromPayload).length > 0
        ? packageFromPayload
        : location
          ? await deps.readVirtualJsonObject(
              location,
              "brain.plugin.validate location",
              sessionId,
            )
          : {};
    if (Object.keys(packageSource).length === 0) {
      return fail("brain.plugin.validate 需要 package 或 location(mem://...)");
    }

    try {
      let pluginSource = readPluginInstallSource(packageSource);
      validatePluginInstallSource(pluginSource);
      pluginSource = await deps.materializeInlinePluginSources(
        pluginSource,
        sessionId,
        { transient: true },
      );
      const manifest = deps.normalizePluginManifest(pluginSource.manifest);
      const pluginId = manifest.id;
      const checks: PluginValidationCheck[] = [];
      const warnings: string[] = [];

      const hasExtensionEntry = deps.hasPluginExtensionEntry(pluginSource);
      const moduleInput = String(
        pluginSource.modulePath ||
          pluginSource.moduleUrl ||
          pluginSource.module ||
          "",
      ).trim();
      const exportName =
        String(pluginSource.exportName || "default").trim() || "default";
      if (hasExtensionEntry && moduleInput) {
        try {
          const moduleUrl = resolvePluginModuleUrl(moduleInput);
          if (isVirtualUri(moduleUrl)) {
            const describe = await deps.invokePluginSandboxRunner({
              sessionId:
                String(
                  pluginSource.moduleSessionId || sessionId || "",
                ).trim() || sessionId,
              modulePath: moduleUrl,
              exportName,
              op: "describe",
            });
            checks.push(
              buildPluginValidationCheck("index.module", true, {
                details: {
                  moduleUrl,
                  exportName,
                  hooks: toStringList(describe.hooks) || [],
                },
              }),
            );
          } else {
            await loadExtensionFactoryFromModule(moduleUrl, exportName);
            checks.push(
              buildPluginValidationCheck("index.module", true, {
                details: {
                  moduleUrl,
                  exportName,
                },
              }),
            );
          }
        } catch (error) {
          checks.push(
            buildPluginValidationCheck("index.module", false, { error }),
          );
        }
      } else {
        warnings.push(
          "未声明 index.js 扩展入口（modulePath/moduleUrl/module）",
        );
      }

      const uiDescriptor = resolveUiExtensionDescriptorFromSource(
        pluginId,
        pluginSource,
        true,
        deps.pluginSandboxDefaultSessionId,
      );
      if (uiDescriptor) {
        try {
          if (isVirtualUri(uiDescriptor.moduleUrl)) {
            const describe = await deps.invokePluginSandboxRunner({
              sessionId:
                String(uiDescriptor.sessionId || sessionId || "").trim() ||
                sessionId,
              modulePath: uiDescriptor.moduleUrl,
              exportName: uiDescriptor.exportName,
              op: "describe",
            });
            checks.push(
              buildPluginValidationCheck("ui.module", true, {
                details: {
                  moduleUrl: uiDescriptor.moduleUrl,
                  exportName: uiDescriptor.exportName,
                  hooks: toStringList(describe.hooks) || [],
                },
              }),
            );
          } else {
            await loadExtensionFactoryFromModule(
              uiDescriptor.moduleUrl,
              uiDescriptor.exportName,
            );
            checks.push(
              buildPluginValidationCheck("ui.module", true, {
                details: {
                  moduleUrl: uiDescriptor.moduleUrl,
                  exportName: uiDescriptor.exportName,
                },
              }),
            );
          }
        } catch (error) {
          checks.push(
            buildPluginValidationCheck("ui.module", false, { error }),
          );
        }
      } else {
        warnings.push(
          "未声明 ui.js 扩展入口（uiModulePath/uiModuleUrl/uiModule）",
        );
      }

      if (!hasExtensionEntry && !uiDescriptor) {
        checks.push(
          buildPluginValidationCheck("entry.module", false, {
            error: "至少需要 index.js 或 ui.js 入口之一",
          }),
        );
      }

      return ok({
        pluginId,
        valid: checks.every((item) => item.ok),
        checks,
        warnings,
        sourceLocation: location || undefined,
      });
    } catch (error) {
      return fail(error);
    }
  }

  if (action === "brain.plugin.install") {
    const location = String(payload.location || payload.path || "").trim();
    const hasInlinePackage = Object.prototype.hasOwnProperty.call(
      payload,
      "package",
    );
    const packageFromPayload = toRecord(payload.package);
    if (hasInlinePackage && Object.keys(packageFromPayload).length === 0) {
      return fail("brain.plugin.install 的 package 必须是 object");
    }
    const sessionId = String(payload.sessionId || "").trim() || "default";
    const packageSource =
      Object.keys(packageFromPayload).length > 0
        ? packageFromPayload
        : location
          ? await deps.readVirtualJsonObject(
              location,
              "brain.plugin.install location",
              sessionId,
            )
          : {};
    if (Object.keys(packageSource).length === 0) {
      return fail("brain.plugin.install 需要 package 或 location(mem://...)");
    }
    let pluginSource: Record<string, unknown>;
    try {
      pluginSource = readPluginInstallSource(packageSource);
      validatePluginInstallSource(pluginSource);
      pluginSource = await deps.materializeInlinePluginSources(
        pluginSource,
        sessionId,
      );
    } catch (error) {
      return fail(error);
    }
    const installPayload = {
      ...payload,
      ...pluginSource,
    } as Record<string, unknown>;
    const manifest = deps.normalizePluginManifest(installPayload.manifest);
    const hasExtensionEntry = deps.hasPluginExtensionEntry(installPayload);
    const hasUiEntry =
      resolveUiExtensionDescriptorFromSource(
        manifest.id,
        installPayload,
        payload.enable === false ? false : true,
        deps.pluginSandboxDefaultSessionId,
      ) != null;
    if (!hasExtensionEntry && !hasUiEntry) {
      return fail("brain.plugin.install 至少需要 index.js 或 ui.js 入口之一");
    }
    const result = await handleBrainPlugin(
      orchestrator,
      {
        ...installPayload,
        type: "brain.plugin.register_extension",
        ...(payload.replace === undefined ? {} : { replace: payload.replace }),
        ...(payload.enable === undefined ? {} : { enable: payload.enable }),
      },
      deps,
    );
    if (!result.ok) return result;
    return ok({
      ...(toRecord(result.data) as Record<string, unknown>),
      sourceLocation: location || undefined,
    });
  }

  if (action === "brain.plugin.enable") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.enable 需要 pluginId");
    orchestrator.enablePlugin(pluginId);
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiExtension = await updateUiExtensionDescriptorEnabled(
      pluginId,
      true,
    );
    await updatePersistedPluginEnabled(
      pluginId,
      true,
      (candidate) => isBuiltinPluginId(candidate, deps.builtinPluginIdPrefix),
    );
    if (uiExtension && !isPluginPersistenceHydrate) {
      notifyUiExtensionLifecycle(
        "brain.plugin.ui_extension.enabled",
        uiExtension,
      );
    }
    return ok({
      pluginId,
      enabled: true,
      plugin: current,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiExtension ? { uiExtension } : {}),
    });
  }

  if (action === "brain.plugin.disable") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.disable 需要 pluginId");
    orchestrator.disablePlugin(pluginId);
    const current =
      orchestrator.listPlugins().find((item) => item.id === pluginId) || null;
    const uiExtension = await updateUiExtensionDescriptorEnabled(
      pluginId,
      false,
    );
    await updatePersistedPluginEnabled(
      pluginId,
      false,
      (candidate) => isBuiltinPluginId(candidate, deps.builtinPluginIdPrefix),
    );
    if (uiExtension && !isPluginPersistenceHydrate) {
      notifyUiExtensionLifecycle(
        "brain.plugin.ui_extension.disabled",
        uiExtension,
      );
    }
    return ok({
      pluginId,
      enabled: false,
      plugin: current,
      llmProviders: orchestrator.listLlmProviders(),
      ...(uiExtension ? { uiExtension } : {}),
    });
  }

  if (action === "brain.plugin.unregister") {
    const pluginId = readPluginId(payload);
    if (!pluginId) return fail("brain.plugin.unregister 需要 pluginId");
    if (isBuiltinPluginId(pluginId, deps.builtinPluginIdPrefix)) {
      return fail(`内置插件不允许卸载: ${pluginId}`);
    }
    const removed = orchestrator.unregisterPlugin(pluginId);
    if (!removed) return fail(`plugin 不存在: ${pluginId}`);
    await removePersistedPluginRecord(pluginId);
    const removedUiExtension = await removeUiExtensionDescriptor(pluginId);
    if (removedUiExtension && !isPluginPersistenceHydrate) {
      notifyUiExtensionLifecycle(
        "brain.plugin.ui_extension.unregistered",
        removedUiExtension,
      );
    }
    await deps.cleanupPluginVirtualArtifacts(
      pluginId,
      String(payload.sessionId || "").trim() || deps.pluginSandboxDefaultSessionId,
    );
    return ok({
      pluginId,
      removed: true,
      llmProviders: orchestrator.listLlmProviders(),
      ...(removedUiExtension ? { uiExtension: removedUiExtension } : {}),
    });
  }

  return fail(`unsupported brain.plugin action: ${action}`);
}
