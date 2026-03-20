/**
 * eval-bridge.ts
 *
 * Service Worker side bridge for executing bash commands in the sandbox page.
 * Uses a single offscreen relay so user-facing extension pages don't directly
 * embed the sandbox iframe.
 */

// --- Types ---

export interface VfsFile {
  path: string;
  content: string;
  /** FNV-1a hash of content. When the iframe already holds a file with the
   *  same path and hash, it can skip re-writing the content. */
  hash?: number;
}

export interface SandboxBashInput {
  command: string;
  files: VfsFile[];
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxBashResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  vfsDiff: Array<{ op: "add" | "modify" | "delete"; path: string; content?: string }>;
}

// --- Internal ---

let requestCounter = 0;

function nextId(): string {
  return `sb-${Date.now()}-${++requestCounter}`;
}

async function ensureOffscreenRelay(): Promise<void> {
  try {
    // Check if offscreen document already exists
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as any],
    });
    if (contexts.length > 0) return;

    await (chrome as any).offscreen.createDocument({
      url: "sandbox-host.html",
      reasons: ["WORKERS"],
      justification: "Host sandbox iframe for plugin code evaluation",
    });
  } catch (err) {
    throw new Error(
      `Failed to create offscreen document: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// --- Public API ---

/**
 * Execute a bash command in the sandbox page.
 * Routes through the offscreen relay to keep the sandbox iframe out of
 * sidepanel and plugin-studio documents.
 */
export async function sandboxBash(input: SandboxBashInput): Promise<SandboxBashResult> {
  const id = nextId();

  await ensureOffscreenRelay();

  const message = {
    type: "sandbox-bash" as const,
    id,
    command: input.command,
    files: input.files,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 120_000,
  };

  try {
    const response = await chrome.runtime.sendMessage(message);

    if (!response || typeof response !== "object") {
      return {
        ok: false,
        stdout: "",
        stderr: "No response from sandbox relay",
        exitCode: 1,
        vfsDiff: [],
      };
    }

    return {
      ok: Boolean(response.ok),
      stdout: String(response.stdout ?? ""),
      stderr: String(response.stderr ?? ""),
      exitCode: Number(response.exitCode ?? 1),
      vfsDiff: Array.isArray(response.vfsDiff) ? response.vfsDiff : [],
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: `Sandbox bridge error: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      vfsDiff: [],
    };
  }
}

/**
 * Reset the sandbox state. Call after SW restarts.
 */
export async function sandboxReset(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "sandbox-reset" });
  } catch {
    // Relay not available, ignore
  }
}
