/**
 * eval-sandbox/main.ts
 *
 * MV3 sandbox page runtime.
 * This page runs with a relaxed CSP that allows eval/new Function().
 * It hosts a LIFO Sandbox instance to execute bash commands that the
 * Service Worker cannot run due to CSP restrictions.
 *
 * Communication: parent window ↔ this page via postMessage.
 */

import { Sandbox } from "@lifo-sh/core";
import { collectSandboxFiles, computeVfsDiff } from "./vfs-sync";

// --- Types ---

interface VfsFile {
  path: string;
  content: string;
  /** FNV-1a hash from SW side. Used to skip re-writing unchanged files. */
  hash?: number;
}

interface BashRequest {
  type: "sandbox-bash";
  id: string;
  command: string;
  files: VfsFile[];
  cwd?: string;
  timeoutMs?: number;
}

interface BashResult {
  type: "sandbox-bash-result";
  id: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  vfsDiff: Array<{ op: "add" | "modify" | "delete"; path: string; content?: string }>;
}

interface PingRequest {
  type: "sandbox-ping";
  id: string;
}

interface ResetRequest {
  type: "sandbox-reset";
}

type SandboxRequest = BashRequest | PingRequest | ResetRequest;

// --- State ---

let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | null = null;
/** Hash cache: tracks known file content hashes to skip redundant writes. */
const knownHashes = new Map<string, number>();

async function ensureSandbox(): Promise<Awaited<ReturnType<typeof Sandbox.create>>> {
  if (!sandbox) {
    sandbox = await Sandbox.create({ persist: false });
  }
  return sandbox;
}

async function resetSandbox(): Promise<void> {
  sandbox = null;
  knownHashes.clear();
}

// --- VFS helpers ---

async function writeFilesToSandbox(
  sb: Awaited<ReturnType<typeof Sandbox.create>>,
  files: VfsFile[]
): Promise<void> {
  for (const file of files) {
    // Skip LIFO special mounts (read-only)
    if (file.path.startsWith("/proc/") || file.path.startsWith("/dev/")) continue;
    // Skip files whose content hasn't changed (hash match)
    if (file.hash != null && knownHashes.get(file.path) === file.hash) continue;
    try {
      const dir = file.path.replace(/\/[^/]+$/, "");
      if (dir && dir !== "/") {
        await sb.fs.mkdir(dir, { recursive: true });
      }
      await sb.fs.writeFile(file.path, file.content);
      if (file.hash != null) {
        knownHashes.set(file.path, file.hash);
      }
    } catch {
      // Skip files that can't be written (e.g. special mounts)
    }
  }
}

// --- Bash execution ---

async function handleBash(req: BashRequest): Promise<BashResult> {
  const sb = await ensureSandbox();

  // Write incoming files to sandbox VFS
  await writeFilesToSandbox(sb, req.files);

  // Snapshot VFS before execution
  const before = await collectSandboxFiles(sb.fs, "/");

  // Set cwd
  if (req.cwd) {
    sb.cwd = req.cwd;
  }

  // Execute command
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const timeoutMs = req.timeoutMs ?? 120_000;
    const pending = sb.commands.run(req.command);

    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sandbox bash timed out")), timeoutMs)
      ),
    ]);

    stdout = String((result as any)?.stdout ?? "");
    stderr = String((result as any)?.stderr ?? "");
    exitCode = Number((result as any)?.exitCode ?? 0);
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  // Snapshot VFS after execution and compute diff
  const after = await collectSandboxFiles(sb.fs, "/");
  const vfsDiff = computeVfsDiff(before, after);

  // Update hash cache to reflect post-execution VFS state
  for (const d of vfsDiff) {
    if (d.op === "delete") {
      knownHashes.delete(d.path);
    }
    // add/modify entries will be re-synced with hash on the next call
  }

  return {
    type: "sandbox-bash-result",
    id: req.id,
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
    vfsDiff,
  };
}

// --- Message handler ---

function getOrigin(): string {
  // In a sandbox page, location.origin is "null" (opaque).
  // We accept messages from any chrome-extension:// origin.
  return "";
}

window.addEventListener("message", async (event: MessageEvent) => {
  // Security: only accept messages from chrome-extension:// origins
  if (
    typeof event.origin !== "string" ||
    !event.origin.startsWith("chrome-extension://")
  ) {
    return;
  }

  const data = event.data as SandboxRequest | undefined;
  if (!data || typeof data.type !== "string") return;

  const source = event.source as WindowProxy | null;
  const origin = event.origin;

  switch (data.type) {
    case "sandbox-ping": {
      source?.postMessage(
        { type: "sandbox-pong", id: data.id },
        origin
      );
      break;
    }
    case "sandbox-reset": {
      await resetSandbox();
      break;
    }
    case "sandbox-bash": {
      try {
        const result = await handleBash(data);
        source?.postMessage(result, origin);
      } catch (err) {
        source?.postMessage(
          {
            type: "sandbox-bash-result",
            id: data.id,
            ok: false,
            stdout: "",
            stderr: err instanceof Error ? err.message : String(err),
            exitCode: 1,
            vfsDiff: [],
          } satisfies BashResult,
          origin
        );
      }
      break;
    }
  }
});

// Signal ready
window.parent?.postMessage({ type: "sandbox-ready" }, "*");
