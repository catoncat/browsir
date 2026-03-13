import { kvGet, kvSet } from "../idb-storage";
import { nowIso } from "../types";
import exampleSendSuccessPluginPackage from "../../../../plugins/example-send-success-global-message/plugin.json";
import exampleMissionHudDogPluginPackage from "../../../../plugins/example-mission-hud-dog/plugin.json";

const PLUGIN_REGISTRY_STORAGE_KEY = "brain.plugin.registry:v1";
const PLUGIN_EXAMPLE_SEED_STORAGE_KEY = "brain.plugin.seed.examples:v1";

export type PersistedPluginKind = "builtin_state" | "extension";

export interface PersistedPluginRecord {
  pluginId: string;
  kind: PersistedPluginKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  source?: Record<string, unknown>;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function clonePersistableRecord<T>(value: T): T | null {
  try {
    return structuredClone(value);
  } catch {
    return null;
  }
}

function normalizePersistedPluginRecord(
  input: unknown,
): PersistedPluginRecord | null {
  const row = toRecord(input);
  const kind = String(row.kind || "").trim() as PersistedPluginKind;
  if (kind !== "builtin_state" && kind !== "extension") {
    return null;
  }
  const source = toRecord(row.source);
  const manifest = toRecord(source.manifest);
  const pluginId =
    String(row.pluginId || "").trim() || String(manifest.id || "").trim();
  if (!pluginId) return null;
  const createdAt = String(row.createdAt || "").trim() || nowIso();
  const updatedAt = String(row.updatedAt || "").trim() || createdAt;
  if (kind === "builtin_state") {
    return {
      pluginId,
      kind,
      enabled: row.enabled !== false,
      createdAt,
      updatedAt,
    };
  }
  if (Object.keys(source).length === 0) return null;
  const clonedSource = clonePersistableRecord(source);
  if (!clonedSource || typeof clonedSource !== "object") return null;
  return {
    pluginId,
    kind,
    enabled: row.enabled !== false,
    createdAt,
    updatedAt,
    source: clonedSource as Record<string, unknown>,
  };
}

export async function readPersistedPluginRecords(): Promise<
  PersistedPluginRecord[]
> {
  const raw = await kvGet(PLUGIN_REGISTRY_STORAGE_KEY);
  const list = Array.isArray(raw) ? raw : [];
  const out: PersistedPluginRecord[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (const item of list) {
    const normalized = normalizePersistedPluginRecord(item);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (seen.has(normalized.pluginId)) {
      changed = true;
      continue;
    }
    seen.add(normalized.pluginId);
    out.push(normalized);
  }
  if (changed || out.length !== list.length) {
    await writePersistedPluginRecords(out);
  }
  return out;
}

async function writePersistedPluginRecords(
  list: PersistedPluginRecord[],
): Promise<void> {
  await kvSet(PLUGIN_REGISTRY_STORAGE_KEY, list);
}

export async function upsertPersistedPluginRecord(
  next: PersistedPluginRecord,
): Promise<PersistedPluginRecord> {
  const list = await readPersistedPluginRecords();
  const index = list.findIndex((item) => item.pluginId === next.pluginId);
  const current = index >= 0 ? list[index] : null;
  const merged: PersistedPluginRecord = {
    ...next,
    createdAt: current?.createdAt || next.createdAt,
    updatedAt: next.updatedAt || nowIso(),
  };
  if (index >= 0) {
    list[index] = merged;
  } else {
    list.push(merged);
  }
  await writePersistedPluginRecords(list);
  return merged;
}

export async function removePersistedPluginRecord(
  pluginId: string,
): Promise<boolean> {
  const id = String(pluginId || "").trim();
  if (!id) return false;
  const list = await readPersistedPluginRecords();
  const next = list.filter((item) => item.pluginId !== id);
  if (next.length === list.length) return false;
  await writePersistedPluginRecords(next);
  return true;
}

export async function updatePersistedPluginEnabled(
  pluginId: string,
  enabled: boolean,
  isBuiltinPluginId: (pluginId: string) => boolean,
): Promise<PersistedPluginRecord | null> {
  const id = String(pluginId || "").trim();
  if (!id) return null;
  const list = await readPersistedPluginRecords();
  const index = list.findIndex((item) => item.pluginId === id);
  if (index >= 0) {
    const next = {
      ...list[index],
      enabled,
      updatedAt: nowIso(),
    };
    list[index] = next;
    await writePersistedPluginRecords(list);
    return next;
  }
  if (!isBuiltinPluginId(id)) return null;
  const next: PersistedPluginRecord = {
    pluginId: id,
    kind: "builtin_state",
    enabled,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  list.push(next);
  await writePersistedPluginRecords(list);
  return next;
}

function defaultExamplePluginSources(): Array<Record<string, unknown>> {
  const out: Record<string, unknown>[] = [];
  const candidates = [
    clonePersistableRecord(exampleSendSuccessPluginPackage),
    clonePersistableRecord(exampleMissionHudDogPluginPackage),
  ];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    out.push(item as Record<string, unknown>);
  }
  return out;
}

export async function seedDefaultExamplePluginRecords(): Promise<void> {
  const seeded = await kvGet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY);
  if (seeded) return;
  let list = await readPersistedPluginRecords();
  const knownIds = new Set(list.map((item) => item.pluginId));
  let changed = false;
  for (const source of defaultExamplePluginSources()) {
    const pluginId = String(toRecord(source.manifest).id || "").trim();
    if (!pluginId || knownIds.has(pluginId)) continue;
    list = [
      ...list,
      {
        pluginId,
        kind: "extension",
        enabled: true,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source,
      },
    ];
    knownIds.add(pluginId);
    changed = true;
  }
  if (changed) {
    await writePersistedPluginRecords(list);
  }
  await kvSet(PLUGIN_EXAMPLE_SEED_STORAGE_KEY, {
    version: 1,
    seededAt: nowIso(),
  });
}
