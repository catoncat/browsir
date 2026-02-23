import { open } from "node:fs/promises";
import { BridgeError } from "../errors";
import { asOptionalNumber, asOptionalString, asString } from "../protocol";
import type { FsGuard } from "../fs-guard";

export interface ReadResult {
  path: string;
  offset: number;
  limit: number;
  size: number;
  truncated: boolean;
  content: string;
}

export async function runRead(
  args: Record<string, unknown>,
  fsGuard: FsGuard,
  maxReadBytes: number,
): Promise<ReadResult> {
  const filePath = asString(args.path, "path");
  const cwd = asOptionalString(args.cwd, "cwd");
  const offset = Math.max(0, Math.floor(asOptionalNumber(args.offset, "offset") ?? 0));
  const requestedLimit = asOptionalNumber(args.limit, "limit") ?? maxReadBytes;
  const limit = Math.max(1, Math.min(maxReadBytes, Math.floor(requestedLimit)));

  const resolved = await fsGuard.resolveRead(filePath, cwd);

  const fh = await open(resolved, "r").catch((err) => {
    throw new BridgeError("E_PATH", "Failed to open file", { path: resolved, cause: String(err) });
  });

  try {
    const stat = await fh.stat();
    const size = stat.size;

    if (offset >= size) {
      return {
        path: resolved,
        offset,
        limit,
        size,
        truncated: false,
        content: "",
      };
    }

    const bytesToRead = Math.min(limit, size - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fh.read(buffer, 0, bytesToRead, offset);

    return {
      path: resolved,
      offset,
      limit,
      size,
      truncated: offset + bytesRead < size,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } finally {
    await fh.close();
  }
}
