export interface VfsDiffEntry {
  op: "add" | "modify" | "delete";
  path: string;
  content?: string;
}

interface SandboxDirEntryLike {
  name?: unknown;
  type?: unknown;
}

interface SandboxStatLike {
  type?: unknown;
}

export interface SandboxFsLike {
  readdir(dir: string): Promise<unknown[]>;
  stat(path: string): Promise<SandboxStatLike>;
  readFile(path: string): Promise<unknown>;
}

function normalizeEntryName(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  if (entry && typeof entry === "object") {
    const row = entry as SandboxDirEntryLike;
    if (typeof row.name === "string") return row.name.trim();
  }
  return "";
}

function normalizeEntryType(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  return String((entry as SandboxDirEntryLike).type || "")
    .trim()
    .toLowerCase();
}

function normalizeStatType(stat: SandboxStatLike | null | undefined): string {
  return String(stat?.type || "")
    .trim()
    .toLowerCase();
}

async function readEntryType(
  fs: SandboxFsLike,
  fullPath: string,
  entry: unknown,
): Promise<string> {
  const hinted = normalizeEntryType(entry);
  if (hinted === "directory" || hinted === "file") return hinted;
  return normalizeStatType(await fs.stat(fullPath));
}

export async function collectSandboxFiles(
  fs: SandboxFsLike,
  dir: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (dir === "/proc" || dir === "/dev") return result;
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const name = normalizeEntryName(entry);
      if (!name) continue;
      const fullPath = dir === "/" ? `/${name}` : `${dir}/${name}`;
      try {
        const type = await readEntryType(fs, fullPath, entry);
        if (type === "directory") {
          const sub = await collectSandboxFiles(fs, fullPath);
          for (const [k, v] of sub) result.set(k, v);
          continue;
        }
        if (type !== "file") continue;
        result.set(fullPath, String(await fs.readFile(fullPath)));
      } catch {
        // Skip unreadable entries.
      }
    }
  } catch {
    // Dir doesn't exist or isn't readable.
  }
  return result;
}

export function computeVfsDiff(
  before: Map<string, string>,
  after: Map<string, string>,
): VfsDiffEntry[] {
  const diff: VfsDiffEntry[] = [];
  for (const [path, content] of after) {
    if (!before.has(path)) {
      diff.push({ op: "add", path, content });
    } else if (before.get(path) !== content) {
      diff.push({ op: "modify", path, content });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      diff.push({ op: "delete", path });
    }
  }
  return diff;
}
