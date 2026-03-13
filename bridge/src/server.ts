import crypto from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { AuditLogger } from "./audit";
import type { AuditRecord } from "./audit";
import { loadConfig, originAllowed } from "./config";
import type { BridgeConfig } from "./config";
import { dispatchInvoke } from "./dispatcher";
import { errorToPayload } from "./errors";
import { FsGuard } from "./fs-guard";
import { parseInvokeFrame } from "./protocol";
import type { EventFrame, InvokeFailure, InvokeSuccess } from "./types";

interface SocketData {
  sessionId: string;
  origin?: string;
  clientAddress?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sendJson(ws: ServerWebSocket<SocketData>, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function eventFrame(
  event: EventFrame["event"],
  data: Record<string, unknown>,
  fields: Partial<Pick<EventFrame, "id" | "sessionId" | "parentSessionId" | "agentId">> = {},
): EventFrame {
  return {
    type: "event",
    event,
    ts: nowIso(),
    ...fields,
    data,
  };
}

function summarizeInvokeMetrics(tool: string, result: Record<string, unknown> | null, durationMs: number) {
  const base: Record<string, unknown> = {
    tool,
    durationMs,
  };

  if (!result) return base;

  if (tool === "bash") {
    base.exitCode = result.exitCode;
    base.bytesOut = result.bytesOut;
    base.stdoutBytes = result.stdoutBytes;
    base.stderrBytes = result.stderrBytes;
    base.truncated = result.truncated;
    base.timeoutHit = result.timeoutHit;
    base.cmdId = result.cmdId;
    base.risk = result.risk;
    return base;
  }

  if (tool === "read") {
    base.size = result.size;
    base.limit = result.limit;
    base.truncated = result.truncated;
    return base;
  }

  if (tool === "write") {
    base.mode = result.mode;
    base.bytesWritten = result.bytesWritten;
    return base;
  }

  if (tool === "edit") {
    base.hunks = result.hunks;
    base.replacements = result.replacements;
    return base;
  }

  if (tool === "stat") {
    base.exists = result.exists;
    base.type = result.type;
    base.size = result.size;
    return base;
  }

  if (tool === "list") {
    base.exists = result.exists;
    base.type = result.type;
    base.entryCount = Array.isArray(result.entries) ? result.entries.length : 0;
    return base;
  }

  return base;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function buildInvokeFingerprint(canonicalTool: string, args: Record<string, unknown>): string {
  const payload = `${canonicalTool}:${stableStringify(args)}`;
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function estimatePayloadBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

interface AuditSink {
  log(record: AuditRecord): Promise<void>;
}

interface StartBridgeServerOptions {
  config?: BridgeConfig;
  auditLogger?: AuditSink;
}

interface DiagnosticExportEnvelope {
  id: string;
  kind: "session_diagnostics";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}

interface DiagnosticExportSummary {
  id: string;
  kind: "session_diagnostics";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  sizeBytes: number;
}

interface DebugSnapshotExportEnvelope {
  id: string;
  kind: "kernel_debug_snapshot";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  payload: Record<string, unknown>;
}

interface DebugSnapshotExportSummary {
  id: string;
  kind: "kernel_debug_snapshot";
  sessionId: string;
  title: string;
  createdAt: string;
  schemaVersion: string;
  sizeBytes: number;
}

function withInvokeResponseMeta(
  out: InvokeSuccess | InvokeFailure,
  logicalSessionId: string,
  agentId?: string,
): InvokeSuccess | InvokeFailure {
  return {
    ...out,
    sessionId: logicalSessionId,
    agentId,
  };
}

function sanitizeFileSegment(value: unknown, fallback: string): string {
  const text = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return text || fallback;
}

function trimForTitle(value: unknown, fallback: string, max = 64): string {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return text.length > max ? text.slice(0, max) : text;
}

function resolveDiagnosticExportFile(config: BridgeConfig, exportId: string): string {
  return path.join(config.diagnosticsPath, `${exportId}.json`);
}

function resolveDebugSnapshotDir(config: BridgeConfig): string {
  return path.join(config.diagnosticsPath, "debug-snapshots");
}

function resolveDebugSnapshotExportFile(config: BridgeConfig, exportId: string): string {
  return path.join(resolveDebugSnapshotDir(config), `${exportId}.json`);
}

async function writeDiagnosticExport(
  config: BridgeConfig,
  input: Record<string, unknown>,
): Promise<{
  item: DiagnosticExportSummary;
  downloadUrl: string;
}> {
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("diagnostics payload must be a JSON object");
  }

  const createdAt = nowIso();
  const sessionId = trimForTitle(input.sessionId, "unknown-session", 120);
  const title = trimForTitle(input.title, "未命名会话", 120);
  const schemaVersion = trimForTitle(
    (payload as Record<string, unknown>).schemaVersion,
    "unknown",
    48,
  );
  const exportId = [
    createdAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, ""),
    sanitizeFileSegment(sessionId, "session"),
    crypto.randomUUID().slice(0, 8),
  ].join("-");
  const envelope: DiagnosticExportEnvelope = {
    id: exportId,
    kind: "session_diagnostics",
    sessionId,
    title,
    createdAt,
    schemaVersion,
    payload: payload as Record<string, unknown>,
  };
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  const filePath = resolveDiagnosticExportFile(config, exportId);

  await mkdir(config.diagnosticsPath, { recursive: true });
  await writeFile(filePath, body, "utf8");

  return {
    item: {
      id: exportId,
      kind: envelope.kind,
      sessionId: envelope.sessionId,
      title: envelope.title,
      createdAt: envelope.createdAt,
      schemaVersion: envelope.schemaVersion,
      sizeBytes: Buffer.byteLength(body, "utf8"),
    },
    downloadUrl: `/api/diagnostics/${encodeURIComponent(exportId)}`,
  };
}

async function readDiagnosticExport(config: BridgeConfig, exportId: string): Promise<{
  envelope: DiagnosticExportEnvelope;
  sizeBytes: number;
}> {
  const safeId = sanitizeFileSegment(exportId, "");
  if (!safeId) {
    throw new Error("invalid diagnostics export id");
  }
  const filePath = resolveDiagnosticExportFile(config, safeId);
  const body = await readFile(filePath, "utf8");
  const parsed = JSON.parse(body) as DiagnosticExportEnvelope;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid diagnostics export payload");
  }
  return {
    envelope: parsed,
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

async function writeDebugSnapshotExport(
  config: BridgeConfig,
  input: Record<string, unknown>,
): Promise<{
  item: DebugSnapshotExportSummary;
  downloadUrl: string;
}> {
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("debug snapshot payload must be a JSON object");
  }

  const createdAt = nowIso();
  const sessionId = trimForTitle(input.sessionId, "global", 120);
  const title = trimForTitle(input.title, "调试快照", 120);
  const schemaVersion = trimForTitle(
    (payload as Record<string, unknown>).schemaVersion,
    "unknown",
    48,
  );
  const exportId = [
    "dbg",
    createdAt.slice(0, 19).replace(/[:T]/g, "").replace(/-/g, ""),
    sanitizeFileSegment(sessionId, "global"),
    crypto.randomUUID().slice(0, 8),
  ].join("-");
  const envelope: DebugSnapshotExportEnvelope = {
    id: exportId,
    kind: "kernel_debug_snapshot",
    sessionId,
    title,
    createdAt,
    schemaVersion,
    payload: payload as Record<string, unknown>,
  };
  const body = `${JSON.stringify(envelope, null, 2)}\n`;
  const filePath = resolveDebugSnapshotExportFile(config, exportId);

  await mkdir(resolveDebugSnapshotDir(config), { recursive: true });
  await writeFile(filePath, body, "utf8");

  return {
    item: {
      id: exportId,
      kind: envelope.kind,
      sessionId: envelope.sessionId,
      title: envelope.title,
      createdAt: envelope.createdAt,
      schemaVersion: envelope.schemaVersion,
      sizeBytes: Buffer.byteLength(body, "utf8"),
    },
    downloadUrl: `/api/debug-snapshots/${encodeURIComponent(exportId)}`,
  };
}

async function readDebugSnapshotExport(config: BridgeConfig, exportId: string): Promise<{
  envelope: DebugSnapshotExportEnvelope;
  sizeBytes: number;
}> {
  const safeId = sanitizeFileSegment(exportId, "");
  if (!safeId) {
    throw new Error("invalid debug snapshot export id");
  }
  const filePath = resolveDebugSnapshotExportFile(config, safeId);
  const body = await readFile(filePath, "utf8");
  const parsed = JSON.parse(body) as DebugSnapshotExportEnvelope;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid debug snapshot export payload");
  }
  return {
    envelope: parsed,
    sizeBytes: Buffer.byteLength(body, "utf8"),
  };
}

async function listDebugSnapshotExports(
  config: BridgeConfig,
): Promise<DebugSnapshotExportSummary[]> {
  await mkdir(resolveDebugSnapshotDir(config), { recursive: true });
  const entries = await readdir(resolveDebugSnapshotDir(config), {
    withFileTypes: true,
  });
  const output: DebugSnapshotExportSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const exportId = entry.name.slice(0, -5);
    try {
      const { envelope, sizeBytes } = await readDebugSnapshotExport(
        config,
        exportId,
      );
      output.push({
        id: String(envelope.id || exportId),
        kind: "kernel_debug_snapshot",
        sessionId: String(envelope.sessionId || ""),
        title: trimForTitle(envelope.title, "调试快照", 120),
        createdAt: String(envelope.createdAt || ""),
        schemaVersion: String(envelope.schemaVersion || ""),
        sizeBytes,
      });
    } catch {
      // 忽略损坏文件，避免整个 list 因单个坏文件失败
    }
  }

  output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return output;
}

async function listDiagnosticExports(config: BridgeConfig): Promise<DiagnosticExportSummary[]> {
  await mkdir(config.diagnosticsPath, { recursive: true });
  const entries = await readdir(config.diagnosticsPath, { withFileTypes: true });
  const output: DiagnosticExportSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const exportId = entry.name.slice(0, -5);
    try {
      const { envelope, sizeBytes } = await readDiagnosticExport(config, exportId);
      output.push({
        id: String(envelope.id || exportId),
        kind: "session_diagnostics",
        sessionId: String(envelope.sessionId || ""),
        title: trimForTitle(envelope.title, "未命名会话", 120),
        createdAt: String(envelope.createdAt || ""),
        schemaVersion: String(envelope.schemaVersion || ""),
        sizeBytes,
      });
    } catch {
      // 忽略损坏文件，避免整个 list 因单个坏文件失败
    }
  }

  output.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return output;
}

export function startBridgeServer(options: StartBridgeServerOptions = {}): Bun.Server<SocketData> {
  const config = options.config ?? loadConfig();
  const fsGuard = new FsGuard(config.mode, config.roots);
  const audit: AuditSink = options.auditLogger ?? new AuditLogger(config.auditPath);

  let activeInvocations = 0;
  let devVersion = `${Date.now()}`;
  const inflightInvocations = new Map<
    string,
    { fingerprint: string; promise: Promise<InvokeSuccess | InvokeFailure> }
  >();
  const completedInvocationCache = new Map<
    string,
    { fingerprint: string; out: InvokeSuccess | InvokeFailure; expiresAt: number; bytes: number }
  >();
  const INVOKE_CACHE_TTL_MS = 30_000;
  const INVOKE_CACHE_MAX_ENTRIES = Math.max(64, config.maxConcurrency * 64);
  const INVOKE_CACHE_MAX_BYTES = Math.max(16 * 1024 * 1024, config.maxReadBytes * Math.max(2, config.maxConcurrency));
  const INVOKE_CACHE_MAX_ENTRY_BYTES = Math.max(256 * 1024, config.maxReadBytes);
  let completedInvocationCacheBytes = 0;

  const buildInvokeCacheKey = (sessionId: string, invokeId: string): string => JSON.stringify([sessionId, invokeId]);
  const pruneCompletedInvocationCache = (): void => {
    const now = Date.now();
    for (const [key, value] of completedInvocationCache.entries()) {
      if (value.expiresAt <= now) {
        completedInvocationCacheBytes = Math.max(0, completedInvocationCacheBytes - value.bytes);
        completedInvocationCache.delete(key);
      }
    }
    while (completedInvocationCache.size > INVOKE_CACHE_MAX_ENTRIES || completedInvocationCacheBytes > INVOKE_CACHE_MAX_BYTES) {
      const oldestKey = completedInvocationCache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      const removed = completedInvocationCache.get(oldestKey);
      if (removed) {
        completedInvocationCacheBytes = Math.max(0, completedInvocationCacheBytes - removed.bytes);
      }
      completedInvocationCache.delete(oldestKey);
    }
  };
  const setCompletedInvocationCache = (key: string, out: InvokeSuccess | InvokeFailure, fingerprint: string): void => {
    const bytes = estimatePayloadBytes(out);
    if (bytes <= 0 || bytes > INVOKE_CACHE_MAX_ENTRY_BYTES) {
      return;
    }
    pruneCompletedInvocationCache();
    const previous = completedInvocationCache.get(key);
    if (previous) {
      completedInvocationCacheBytes = Math.max(0, completedInvocationCacheBytes - previous.bytes);
      completedInvocationCache.delete(key);
    }
    completedInvocationCache.set(key, {
      fingerprint,
      out,
      expiresAt: Date.now() + INVOKE_CACHE_TTL_MS,
      bytes,
    });
    completedInvocationCacheBytes += bytes;
    while (completedInvocationCache.size > INVOKE_CACHE_MAX_ENTRIES || completedInvocationCacheBytes > INVOKE_CACHE_MAX_BYTES) {
      const oldestKey = completedInvocationCache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      const removed = completedInvocationCache.get(oldestKey);
      if (removed) {
        completedInvocationCacheBytes = Math.max(0, completedInvocationCacheBytes - removed.bytes);
      }
      completedInvocationCache.delete(oldestKey);
    }
  };

  const safeAuditLog = async (
    record: AuditRecord,
    observe?: {
      ws: ServerWebSocket<SocketData>;
      id?: string;
      sessionId?: string;
      parentSessionId?: string;
      agentId?: string;
    },
  ): Promise<void> => {
    try {
      await audit.log(record);
    } catch (err) {
      const error = errorToPayload(err);
      console.warn(
        `[bridge] audit.log failed event=${record.event} code=${error.code} message=${error.message}`,
      );
      if (observe?.ws && observe.id && observe.sessionId) {
        try {
          sendJson(
            observe.ws,
            eventFrame(
              "invoke.stderr",
              {
                source: "audit",
                chunk: `[bridge.audit] failed to persist audit event=${record.event} code=${error.code}`,
              },
              {
                id: observe.id,
                sessionId: observe.sessionId,
                parentSessionId: observe.parentSessionId,
                agentId: observe.agentId,
              },
            ),
          );
        } catch (sendErr) {
          const sendError = errorToPayload(sendErr);
          console.warn(
            `[bridge] failed to emit audit failure telemetry id=${observe.id} code=${sendError.code} message=${sendError.message}`,
          );
        }
      }
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,

    async fetch(req, serverRef) {
      const url = new URL(req.url);
      const tokenFromReq = url.searchParams.get("token") ?? req.headers.get("x-bridge-token") ?? "";
      const tokenOk = tokenFromReq === config.token;

      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          mode: config.mode,
          enableBashExec: config.enableBashExec,
          host: config.host,
          port: config.port,
          activeInvocations,
          devVersion,
        });
      }

      if (url.pathname === "/dev/version") {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({
          ok: true,
          version: devVersion,
        });
      }

      if (url.pathname === "/dev/bump") {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        devVersion = `${Date.now()}`;
        void safeAuditLog({
          ts: nowIso(),
          level: "info",
          event: "dev.bump",
          data: {
            version: devVersion,
          },
        });
        return Response.json({
          ok: true,
          version: devVersion,
        });
      }

      if (url.pathname === "/api/diagnostics") {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method === "GET") {
          return Response.json({
            ok: true,
            items: await listDiagnosticExports(config),
          });
        }
        if (req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return new Response("invalid json", { status: 400 });
          }
          try {
            const { item, downloadUrl } = await writeDiagnosticExport(
              config,
              (body && typeof body === "object" ? body : {}) as Record<string, unknown>,
            );
            return Response.json({
              ok: true,
              item,
              downloadUrl,
            });
          } catch (error) {
            return Response.json(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname === "/api/debug-snapshots") {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method === "GET") {
          return Response.json({
            ok: true,
            items: await listDebugSnapshotExports(config),
          });
        }
        if (req.method === "POST") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return new Response("invalid json", { status: 400 });
          }
          try {
            const { item, downloadUrl } = await writeDebugSnapshotExport(
              config,
              (body && typeof body === "object"
                ? body
                : {}) as Record<string, unknown>,
            );
            return Response.json({
              ok: true,
              item,
              downloadUrl,
            });
          } catch (error) {
            return Response.json(
              {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              },
              { status: 400 },
            );
          }
        }
        return new Response("method not allowed", { status: 405 });
      }

      if (url.pathname.startsWith("/api/diagnostics/")) {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 });
        }
        const exportId = decodeURIComponent(url.pathname.slice("/api/diagnostics/".length));
        try {
          const { envelope } = await readDiagnosticExport(config, exportId);
          return new Response(`${JSON.stringify(envelope, null, 2)}\n`, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="${sanitizeFileSegment(exportId, "diagnostics")}.json"`,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes("ENOENT") ? 404 : 400;
          return Response.json({ ok: false, error: message }, { status });
        }
      }

      if (url.pathname.startsWith("/api/debug-snapshots/")) {
        if (!tokenOk) {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 });
        }
        const exportId = decodeURIComponent(
          url.pathname.slice("/api/debug-snapshots/".length),
        );
        try {
          const { envelope } = await readDebugSnapshotExport(config, exportId);
          return new Response(`${JSON.stringify(envelope, null, 2)}\n`, {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="${sanitizeFileSegment(exportId, "debug-snapshot")}.json"`,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.includes("ENOENT") ? 404 : 400;
          return Response.json({ ok: false, error: message }, { status });
        }
      }

      if (url.pathname !== "/ws") {
        return new Response("not found", { status: 404 });
      }

      if (!tokenOk) {
        return new Response("unauthorized", { status: 401 });
      }

      const origin = req.headers.get("origin") ?? undefined;
      if (!originAllowed(origin, config.allowOrigins)) {
        return new Response("forbidden origin", { status: 403 });
      }

      const clientAddress = req.headers.get("x-forwarded-for") ?? undefined;
      const sessionId = crypto.randomUUID();

      const upgraded = serverRef.upgrade(req, {
        data: {
          sessionId,
          origin,
          clientAddress,
        },
      });

      if (!upgraded) {
        return new Response("upgrade failed", { status: 500 });
      }

      return;
    },

    websocket: {
      open(ws) {
        void safeAuditLog({
          ts: nowIso(),
          level: "info",
          event: "ws.open",
          sessionId: ws.data.sessionId,
          data: {
            origin: ws.data.origin,
            clientAddress: ws.data.clientAddress,
          },
        });
      },

      message(ws, message) {
        void (async () => {
          let frame;
          try {
            frame = parseInvokeFrame(message);
          } catch (err) {
            const error = errorToPayload(err);
            const out: InvokeFailure = {
              id: "unknown",
              ok: false,
              error,
            };
            sendJson(ws, out);
            await safeAuditLog({
              ts: nowIso(),
              level: "warn",
              event: "invoke.parse_failed",
              sessionId: ws.data.sessionId,
              data: error,
            });
            return;
          }

          const logicalSessionId = frame.sessionId ?? ws.data.sessionId;
          const invokeCacheKey = buildInvokeCacheKey(logicalSessionId, frame.id);
          const requestFingerprint = buildInvokeFingerprint(frame.canonicalTool, frame.args);
          pruneCompletedInvocationCache();

          const cached = completedInvocationCache.get(invokeCacheKey);
          if (cached && cached.expiresAt > Date.now()) {
            if (cached.fingerprint !== requestFingerprint) {
              sendJson(ws, {
                id: frame.id,
                ok: false,
                sessionId: logicalSessionId,
                agentId: frame.agentId,
                error: {
                  code: "E_ARGS",
                  message: "duplicate invoke id with mismatched tool/args",
                  details: {
                    invokeId: frame.id,
                    canonicalTool: frame.canonicalTool,
                    logicalSessionId,
                  },
                },
              } satisfies InvokeFailure);
              return;
            }
            const dedupedOut = withInvokeResponseMeta(cached.out, logicalSessionId, frame.agentId);
            sendJson(ws, dedupedOut);
            sendJson(
              ws,
              eventFrame(
                "invoke.finished",
                { ok: dedupedOut.ok, deduped: true, cacheHit: true },
                {
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                },
              ),
            );
            await safeAuditLog(
              {
                ts: nowIso(),
                level: "info",
                event: "invoke.dedup_cached",
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
                data: {
                  tool: frame.tool,
                  canonicalTool: frame.canonicalTool,
                },
              },
              {
                ws,
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
              },
            );
            return;
          }

          const inflight = inflightInvocations.get(invokeCacheKey);
          if (inflight) {
            if (inflight.fingerprint !== requestFingerprint) {
              sendJson(ws, {
                id: frame.id,
                ok: false,
                sessionId: logicalSessionId,
                agentId: frame.agentId,
                error: {
                  code: "E_ARGS",
                  message: "duplicate invoke id with mismatched tool/args",
                  details: {
                    invokeId: frame.id,
                    canonicalTool: frame.canonicalTool,
                    logicalSessionId,
                  },
                },
              } satisfies InvokeFailure);
              return;
            }
            const out = await inflight.promise;
            const dedupedOut = withInvokeResponseMeta(out, logicalSessionId, frame.agentId);
            sendJson(ws, dedupedOut);
            sendJson(
              ws,
              eventFrame(
                "invoke.finished",
                { ok: dedupedOut.ok, deduped: true, cacheHit: false },
                {
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                },
              ),
            );
            await safeAuditLog(
              {
                ts: nowIso(),
                level: "info",
                event: "invoke.dedup_joined",
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
                data: {
                  tool: frame.tool,
                  canonicalTool: frame.canonicalTool,
                },
              },
              {
                ws,
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
              },
            );
            return;
          }

          if (activeInvocations >= config.maxConcurrency) {
            const out: InvokeFailure = {
              id: frame.id,
              ok: false,
              sessionId: logicalSessionId,
              agentId: frame.agentId,
              error: {
                code: "E_BUSY",
                message: "Bridge concurrency limit reached",
                details: {
                  maxConcurrency: config.maxConcurrency,
                  logicalSessionId,
                },
              },
            };
            sendJson(ws, out);
            return;
          }

          activeInvocations += 1;
          const startedAt = Date.now();
          const invokePromise: Promise<InvokeSuccess | InvokeFailure> = (async () => {
            sendJson(
              ws,
              eventFrame(
                "invoke.started",
                { tool: frame.tool, canonicalTool: frame.canonicalTool },
                {
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                },
              ),
            );

            await safeAuditLog(
              {
                ts: nowIso(),
                level: "info",
                event: "invoke.started",
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
                data: {
                  tool: frame.tool,
                  canonicalTool: frame.canonicalTool,
                  args: frame.args,
                },
              },
              {
                ws,
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
              },
            );
            try {
              const data = await dispatchInvoke(frame, { config, fsGuard }, (stream, chunk) => {
                sendJson(
                  ws,
                  eventFrame(stream === "stdout" ? "invoke.stdout" : "invoke.stderr", { chunk }, {
                    id: frame.id,
                    sessionId: logicalSessionId,
                    parentSessionId: frame.parentSessionId,
                    agentId: frame.agentId,
                  }),
                );
              });

              const out: InvokeSuccess = {
                id: frame.id,
                ok: true,
                data,
                sessionId: logicalSessionId,
                agentId: frame.agentId,
              };

              const durationMs = Date.now() - startedAt;
              const metrics = summarizeInvokeMetrics(frame.canonicalTool, data, durationMs);
              sendJson(
                ws,
                eventFrame(
                  "invoke.finished",
                  { ok: true, durationMs, metrics },
                  {
                    id: frame.id,
                    sessionId: logicalSessionId,
                    parentSessionId: frame.parentSessionId,
                    agentId: frame.agentId,
                  },
                ),
              );

              await safeAuditLog(
                {
                  ts: nowIso(),
                  level: "info",
                  event: "invoke.finished",
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                  data: {
                    ok: true,
                    durationMs,
                    tool: frame.tool,
                    canonicalTool: frame.canonicalTool,
                    metrics,
                    result: data,
                  },
                },
                {
                  ws,
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                },
              );

              return out;
            } catch (err) {
              const error = errorToPayload(err);
              const out: InvokeFailure = {
                id: frame.id,
                ok: false,
                error,
                sessionId: logicalSessionId,
                agentId: frame.agentId,
              };

              const durationMs = Date.now() - startedAt;
              const metrics = summarizeInvokeMetrics(frame.canonicalTool, null, durationMs);
              sendJson(
                ws,
                eventFrame(
                  "invoke.finished",
                  { ok: false, durationMs, error, metrics },
                  {
                    id: frame.id,
                    sessionId: logicalSessionId,
                    parentSessionId: frame.parentSessionId,
                    agentId: frame.agentId,
                  },
                ),
              );

              await safeAuditLog(
                {
                  ts: nowIso(),
                  level: "error",
                  event: "invoke.failed",
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                  data: {
                    durationMs,
                    tool: frame.tool,
                    canonicalTool: frame.canonicalTool,
                    metrics,
                    error,
                  },
                },
                {
                  ws,
                  id: frame.id,
                  sessionId: logicalSessionId,
                  parentSessionId: frame.parentSessionId,
                  agentId: frame.agentId,
                },
              );

              return out;
            }
          })();

          // 先占位 inflight，避免 check->set 之间出现并发窗口。
          inflightInvocations.set(invokeCacheKey, { fingerprint: requestFingerprint, promise: invokePromise });
          try {
            const out = await invokePromise;
            sendJson(ws, out);
            setCompletedInvocationCache(invokeCacheKey, out, requestFingerprint);
          } finally {
            inflightInvocations.delete(invokeCacheKey);
            activeInvocations -= 1;
          }
        })();
      },

      close(ws, code, reason) {
        void safeAuditLog({
          ts: nowIso(),
          level: "info",
          event: "ws.close",
          sessionId: ws.data.sessionId,
          data: {
            code,
            reason,
          },
        });
      },
    },
  });

  console.log(
    `[bridge] ws://%s:%d/ws  mode=%s  maxConcurrency=%d  bash.exec=%s  audit=%s`,
    config.host,
    server.port,
    config.mode,
    config.maxConcurrency,
    config.enableBashExec ? "enabled" : "disabled",
    config.auditPath,
  );

  if (config.token === "dev-token-change-me") {
    console.warn("[bridge] BRIDGE_TOKEN is using default value. Set BRIDGE_TOKEN in production.");
  }

  return server;
}
