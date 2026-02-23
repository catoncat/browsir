import crypto from "node:crypto";
import type { ServerWebSocket } from "bun";
import { AuditLogger } from "./audit";
import { loadConfig, originAllowed } from "./config";
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

  return base;
}

export function startBridgeServer(): void {
  const config = loadConfig();
  const fsGuard = new FsGuard(config.mode, config.roots);
  const audit = new AuditLogger(config.auditPath);

  let activeInvocations = 0;
  let devVersion = `${Date.now()}`;

  const server = Bun.serve<SocketData>({
    hostname: config.host,
    port: config.port,

    fetch(req, serverRef) {
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
        void audit.log({
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
        void audit.log({
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
            await audit.log({
              ts: nowIso(),
              level: "warn",
              event: "invoke.parse_failed",
              sessionId: ws.data.sessionId,
              data: error,
            });
            return;
          }

          if (activeInvocations >= config.maxConcurrency) {
            const out: InvokeFailure = {
              id: frame.id,
              ok: false,
              sessionId: frame.sessionId,
              agentId: frame.agentId,
              error: {
                code: "E_BUSY",
                message: "Bridge concurrency limit reached",
                details: {
                  maxConcurrency: config.maxConcurrency,
                },
              },
            };
            sendJson(ws, out);
            return;
          }

          const logicalSessionId = frame.sessionId ?? ws.data.sessionId;

          activeInvocations += 1;
          const startedAt = Date.now();

          sendJson(
            ws,
            eventFrame(
              "invoke.started",
              { tool: frame.tool },
              {
                id: frame.id,
                sessionId: logicalSessionId,
                parentSessionId: frame.parentSessionId,
                agentId: frame.agentId,
              },
            ),
          );

          await audit.log({
            ts: nowIso(),
            level: "info",
            event: "invoke.started",
            id: frame.id,
            sessionId: logicalSessionId,
            parentSessionId: frame.parentSessionId,
            agentId: frame.agentId,
            data: {
              tool: frame.tool,
              args: frame.args,
            },
          });

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
            sendJson(ws, out);

            const durationMs = Date.now() - startedAt;
            const metrics = summarizeInvokeMetrics(frame.tool, data, durationMs);
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

            await audit.log({
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
                metrics,
                result: data,
              },
            });
          } catch (err) {
            const error = errorToPayload(err);
            const out: InvokeFailure = {
              id: frame.id,
              ok: false,
              error,
              sessionId: logicalSessionId,
              agentId: frame.agentId,
            };
            sendJson(ws, out);

            const durationMs = Date.now() - startedAt;
            const metrics = summarizeInvokeMetrics(frame.tool, null, durationMs);
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

            await audit.log({
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
                metrics,
                error,
              },
            });
          } finally {
            activeInvocations -= 1;
          }
        })();
      },

      close(ws, code, reason) {
        void audit.log({
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
}
