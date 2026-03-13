import { stat } from "node:fs/promises";
import { asOptionalString, asString } from "../protocol";
import type { FsGuard } from "../fs-guard";

export interface StatResult {
  path: string;
  exists: boolean;
  type: "file" | "directory" | "other" | "missing";
  size: number | null;
  mtimeMs: number | null;
}

export async function runStat(
  args: Record<string, unknown>,
  fsGuard: FsGuard,
): Promise<StatResult> {
  const filePath = asString(args.path, "path");
  const cwd = asOptionalString(args.cwd, "cwd");
  const resolved = await fsGuard.resolveInspect(filePath, cwd);
  const row = await stat(resolved).catch(() => null);
  if (!row) {
    return {
      path: resolved,
      exists: false,
      type: "missing",
      size: null,
      mtimeMs: null,
    };
  }
  return {
    path: resolved,
    exists: true,
    type: row.isFile() ? "file" : row.isDirectory() ? "directory" : "other",
    size: typeof row.size === "number" ? row.size : null,
    mtimeMs: Number.isFinite(Number(row.mtimeMs)) ? Number(row.mtimeMs) : null,
  };
}
