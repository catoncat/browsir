import { resolveCommand } from "../cmd-registry";
import { BridgeError } from "../errors";
import { asOptionalNumber, asOptionalString, asString, asStringArray } from "../protocol";
import type { FsGuard } from "../fs-guard";

export interface BashResult {
  cmdId: string;
  argv: string[];
  risk: "low" | "medium" | "high";
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  bytesOut: number;
  durationMs: number;
  truncated: boolean;
  timeoutHit: boolean;
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array> | null,
  label: "stdout" | "stderr",
  maxBytes: number,
  onChunk: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!stream) {
    return { text: "", bytes: 0, truncated: false };
  }

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const chunks: string[] = [];

  let totalBytes = 0;
  let truncated = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    const chunkBytes = value.byteLength;
    if (totalBytes >= maxBytes) {
      truncated = true;
      continue;
    }

    const allowed = Math.min(chunkBytes, maxBytes - totalBytes);
    const slice = allowed === chunkBytes ? value : value.subarray(0, allowed);
    const chunk = decoder.decode(slice, { stream: true });

    totalBytes += allowed;
    chunks.push(chunk);
    onChunk?.(label, chunk);

    if (allowed < chunkBytes) {
      truncated = true;
    }
  }

  chunks.push(decoder.decode());

  return {
    text: chunks.join(""),
    bytes: totalBytes,
    truncated,
  };
}

export async function runBash(
  args: Record<string, unknown>,
  fsGuard: FsGuard,
  strictMode: boolean,
  enableBashExec: boolean,
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
  maxOutputBytes: number,
  onChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<BashResult> {
  const cmdId = asString(args.cmdId, "cmdId");
  const cmdArgs = args.args ? asStringArray(args.args, "args") : [];
  const cwdArg = asOptionalString(args.cwd, "cwd");
  const timeoutRaw = asOptionalNumber(args.timeoutMs, "timeoutMs") ?? defaultTimeoutMs;
  const timeoutMs = Math.max(200, Math.min(maxTimeoutMs, Math.floor(timeoutRaw)));

  const cwd = await fsGuard.resolveCwd(cwdArg);
  const resolved = resolveCommand(cmdId, cmdArgs, {
    strictMode,
    enableBashExec,
  });

  const start = Date.now();
  const proc = Bun.spawn(resolved.argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: process.env,
  });

  let timeoutHit = false;
  const timer = setTimeout(() => {
    timeoutHit = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    readStreamLimited(proc.stdout, "stdout", maxOutputBytes, onChunk),
    readStreamLimited(proc.stderr, "stderr", maxOutputBytes, onChunk),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timeoutHit) {
    throw new BridgeError("E_TIMEOUT", "Command timed out", {
      cmdId,
      timeoutMs,
      argv: resolved.argv,
    });
  }

  const durationMs = Date.now() - start;

  return {
    cmdId,
    argv: resolved.argv,
    risk: resolved.risk,
    cwd,
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    bytesOut: stdout.bytes + stderr.bytes,
    durationMs,
    truncated: stdout.truncated || stderr.truncated,
    timeoutHit: false,
  };
}
