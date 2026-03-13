import { realpathSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "./errors";
import type { BridgeMode } from "./config";

function hasPathPrefix(target: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(normalizedRoot);
}

function expandUserPath(input: string): string {
  const raw = String(input || "").trim();
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

export class FsGuard {
  private readonly mode: BridgeMode;
  private readonly roots: string[];

  constructor(mode: BridgeMode, roots: string[]) {
    this.mode = mode;
    this.roots = roots.map((root) => {
      const abs = path.resolve(root);
      try {
        return realpathSync(abs);
      } catch {
        return abs;
      }
    });
  }

  private async resolveExisting(absPath: string): Promise<string> {
    return realpath(absPath);
  }

  private async resolveForCreate(absPath: string): Promise<string> {
    const pendingSegments: string[] = [];
    let cursor = absPath;

    while (true) {
      try {
        const existingReal = await realpath(cursor);
        return pendingSegments.length > 0
          ? path.join(existingReal, ...pendingSegments.reverse())
          : existingReal;
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          throw new BridgeError("E_PATH", "Path parent does not exist", {
            path: absPath,
          });
        }
        pendingSegments.push(path.basename(cursor));
        cursor = parent;
      }
    }
  }

  private assertAllowed(canonical: string): void {
    if (this.mode === "god") return;

    if (this.roots.length === 0) {
      throw new BridgeError("E_PATH", "Strict mode requires BRIDGE_ROOTS");
    }

    const allowed = this.roots.some((root) => hasPathPrefix(canonical, root));
    if (!allowed) {
      throw new BridgeError("E_PATH", "Path denied by strict root policy", {
        path: canonical,
        roots: this.roots,
      });
    }
  }

  async resolveRead(filePath: string, cwd?: string): Promise<string> {
    const absPath = path.resolve(
      expandUserPath(cwd ?? process.cwd()),
      expandUserPath(filePath),
    );
    const canonical = await this.resolveExisting(absPath).catch(() => {
      throw new BridgeError("E_PATH", "File does not exist", { path: absPath });
    });
    this.assertAllowed(canonical);
    return canonical;
  }

  async resolveWrite(filePath: string, cwd?: string): Promise<string> {
    const absPath = path.resolve(
      expandUserPath(cwd ?? process.cwd()),
      expandUserPath(filePath),
    );
    const canonical = await this.resolveExisting(absPath).catch(async () => {
      return this.resolveForCreate(absPath);
    });
    this.assertAllowed(canonical);
    return canonical;
  }

  async resolveInspect(filePath: string, cwd?: string): Promise<string> {
    return this.resolveWrite(filePath, cwd);
  }

  async resolveCwd(cwd?: string): Promise<string> {
    const abs = path.resolve(expandUserPath(cwd ?? process.cwd()));
    const canonical = await realpath(abs).catch(() => {
      throw new BridgeError("E_PATH", "cwd does not exist", { cwd: abs });
    });
    this.assertAllowed(canonical);
    await access(canonical).catch(() => {
      throw new BridgeError("E_PATH", "cwd not accessible", { cwd: canonical });
    });
    return canonical;
  }
}
