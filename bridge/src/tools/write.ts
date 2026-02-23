import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "../errors";
import { asOptionalString, asString } from "../protocol";
import type { FsGuard } from "../fs-guard";

export interface WriteResult {
  path: string;
  mode: "overwrite" | "append" | "create";
  bytesWritten: number;
  sha256: string;
}

export async function runWrite(args: Record<string, unknown>, fsGuard: FsGuard): Promise<WriteResult> {
  const filePath = asString(args.path, "path");
  const cwd = asOptionalString(args.cwd, "cwd");
  const content = asString(args.content, "content");
  const modeRaw = (args.mode ?? "overwrite") as unknown;

  if (typeof modeRaw !== "string" || !["overwrite", "append", "create"].includes(modeRaw)) {
    throw new BridgeError("E_ARGS", "mode must be overwrite|append|create");
  }

  const mode = modeRaw as "overwrite" | "append" | "create";
  const resolved = await fsGuard.resolveWrite(filePath, cwd);

  await mkdir(path.dirname(resolved), { recursive: true });

  const flag = mode === "overwrite" ? "w" : mode === "append" ? "a" : "wx";

  await writeFile(resolved, content, { encoding: "utf8", flag }).catch((err) => {
    if (mode === "create") {
      throw new BridgeError("E_PATH", "File already exists for create mode", {
        path: resolved,
        cause: String(err),
      });
    }
    throw new BridgeError("E_PATH", "Failed to write file", { path: resolved, cause: String(err) });
  });

  return {
    path: resolved,
    mode,
    bytesWritten: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}
