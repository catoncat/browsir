import { readdir, stat } from "node:fs/promises";
import { asOptionalString, asString } from "../protocol";
import type { FsGuard } from "../fs-guard";

export interface ListEntryResult {
  name: string;
  path: string;
  type: "file" | "directory" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export interface ListResult {
  path: string;
  exists: boolean;
  type: "directory" | "missing" | "other";
  entries: ListEntryResult[];
}

export async function runList(
  args: Record<string, unknown>,
  fsGuard: FsGuard,
): Promise<ListResult> {
  const targetPath = asString(args.path, "path");
  const cwd = asOptionalString(args.cwd, "cwd");
  const resolved = await fsGuard.resolveInspect(targetPath, cwd);
  const rootStat = await stat(resolved).catch(() => null);
  if (!rootStat) {
    return {
      path: resolved,
      exists: false,
      type: "missing",
      entries: [],
    };
  }
  if (!rootStat.isDirectory()) {
    return {
      path: resolved,
      exists: true,
      type: "other",
      entries: [],
    };
  }

  const dirents = await readdir(resolved, { withFileTypes: true });
  const entries: ListEntryResult[] = [];
  for (const dirent of dirents) {
    const entryPath = `${resolved}/${dirent.name}`;
    const entryStat = await stat(entryPath).catch(() => null);
    entries.push({
      name: dirent.name,
      path: entryPath,
      type: dirent.isFile()
        ? "file"
        : dirent.isDirectory()
          ? "directory"
          : "other",
      size: entryStat && typeof entryStat.size === "number" ? entryStat.size : null,
      mtimeMs:
        entryStat && Number.isFinite(Number(entryStat.mtimeMs))
          ? Number(entryStat.mtimeMs)
          : null,
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "directory") return -1;
      if (b.type === "directory") return 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: resolved,
    exists: true,
    type: "directory",
    entries,
  };
}
