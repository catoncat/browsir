type JsonRecord = Record<string, unknown>;

export type FilesystemInspectRuntime = "host" | "browser";
export type FilesystemEntryType = "file" | "directory" | "other" | "missing";

export interface FilesystemStatResult {
  path: string;
  exists: boolean;
  type: FilesystemEntryType;
  size: number | null;
  mtimeMs: number | null;
}

export interface FilesystemListEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export interface FilesystemListResult {
  path: string;
  exists: boolean;
  type: "directory" | "other" | "missing";
  entries: FilesystemListEntry[];
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function toNullableFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeEntryType(value: unknown): FilesystemEntryType {
  const text = String(value || "").trim().toLowerCase();
  if (text === "file") return "file";
  if (text === "directory") return "directory";
  if (text === "missing") return "missing";
  return "other";
}

function normalizeStatResult(raw: unknown): FilesystemStatResult {
  const row = toRecord(raw);
  const type = normalizeEntryType(row.type);
  return {
    path: String(row.path || "").trim(),
    exists: row.exists !== false && type !== "missing",
    type,
    size: toNullableFiniteNumber(row.size),
    mtimeMs: toNullableFiniteNumber(row.mtimeMs),
  };
}

function normalizeListResult(raw: unknown): FilesystemListResult {
  const row = toRecord(raw);
  const type = normalizeEntryType(row.type);
  const entriesRaw = Array.isArray(row.entries) ? row.entries : [];
  const entries: FilesystemListEntry[] = entriesRaw
    .map((item) => toRecord(item))
    .map((item) => {
      const entryType = normalizeEntryType(item.type);
      const entry: FilesystemListEntry = {
        name: String(item.name || "").trim(),
        path: String(item.path || "").trim(),
        type:
          entryType === "directory"
            ? "directory"
            : entryType === "file"
              ? "file"
            : "other",
        size: toNullableFiniteNumber(item.size),
        mtimeMs: toNullableFiniteNumber(item.mtimeMs),
      };
      return entry;
    })
    .filter((item) => item.name.length > 0);
  return {
    path: String(row.path || "").trim(),
    exists: row.exists !== false && type !== "missing",
    type: type === "directory" ? "directory" : type === "missing" ? "missing" : "other",
    entries,
  };
}

export function createFilesystemInspectService(input: {
  invokeHostTool: (frame: JsonRecord) => Promise<JsonRecord>;
  invokeBrowserTool: (frame: JsonRecord) => Promise<JsonRecord>;
}) {
  async function stat(params: {
    sessionId: string;
    runtime: FilesystemInspectRuntime;
    path: string;
    cwd?: string;
  }): Promise<FilesystemStatResult> {
    const frame: JsonRecord = {
      tool: "stat",
      sessionId: params.sessionId,
      args: {
        path: params.path,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.runtime === "browser" ? { runtime: "sandbox" } : {}),
      },
    };
    const raw =
      params.runtime === "browser"
        ? await input.invokeBrowserTool(frame)
        : await input.invokeHostTool(frame);
    return normalizeStatResult(raw);
  }

  async function list(params: {
    sessionId: string;
    runtime: FilesystemInspectRuntime;
    path: string;
    cwd?: string;
  }): Promise<FilesystemListResult> {
    const frame: JsonRecord = {
      tool: "list",
      sessionId: params.sessionId,
      args: {
        path: params.path,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.runtime === "browser" ? { runtime: "sandbox" } : {}),
      },
    };
    const raw =
      params.runtime === "browser"
        ? await input.invokeBrowserTool(frame)
        : await input.invokeHostTool(frame);
    return normalizeListResult(raw);
  }

  return {
    stat,
    list,
  };
}
