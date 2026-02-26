import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { BridgeConfig } from "../src/config";
import { registerInvokeToolHandler, unregisterInvokeToolHandler } from "../src/dispatcher";
import { startBridgeServer } from "../src/server";
import { registerToolContract, unregisterToolContract } from "../src/tool-registry";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("unable to get test port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createTestConfig(root: string, port: number, maxConcurrency = 4): BridgeConfig {
  return {
    host: "127.0.0.1",
    port,
    token: "test-token",
    mode: "god",
    enableBashExec: true,
    roots: [root],
    allowOrigins: [],
    maxOutputBytes: 64 * 1024,
    maxReadBytes: 64 * 1024,
    maxConcurrency,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    auditPath: path.join(root, "audit.log"),
  };
}

async function connectWs(wsUrl: string): Promise<{
  ws: WebSocket;
  messages: any[];
  send: (payload: unknown) => void;
  close: () => Promise<void>;
}> {
  const ws = new WebSocket(wsUrl);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timeout: ${wsUrl}`)), 3000);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`websocket open failed: ${wsUrl}`));
    });
  });

  ws.addEventListener("message", (event) => {
    try {
      messages.push(JSON.parse(String(event.data)));
    } catch {
      // 忽略非 JSON 帧
    }
  });

  return {
    ws,
    messages,
    send: (payload: unknown) => ws.send(JSON.stringify(payload)),
    close: async () => {
      if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        ws.close();
      });
    },
  };
}

async function waitForMessages(
  messages: any[],
  predicate: (value: any) => boolean,
  expectedCount: number,
  timeoutMs = 3000,
): Promise<any[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = messages.filter(predicate);
    if (matched.length >= expectedCount) return matched;
    await sleep(10);
  }
  throw new Error(`waitForMessages timeout: expectedCount=${expectedCount}`);
}

describe("bridge server", () => {
  test("dedup race-free and dedup responses use current request metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-server-dedup-"));
    const canonicalTool = "test.delay.echo";
    const port = await getFreePort();
    const config = createTestConfig(root, port, 4);

    let invokeCount = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    registerToolContract({ name: canonicalTool }, { replace: true });
    registerInvokeToolHandler(
      canonicalTool,
      async () => {
        invokeCount += 1;
        await gate;
        return { from: canonicalTool };
      },
      { replace: true },
    );

    const server = startBridgeServer({ config });
    const wsUrl = `ws://${config.host}:${server.port}/ws?token=${config.token}`;
    const client = await connectWs(wsUrl);

    try {
      client.send({
        type: "invoke",
        id: "dup-1",
        tool: ` ${canonicalTool} `,
        args: {},
        sessionId: "logical-1",
        agentId: "agent-1",
      });
      client.send({
        type: "invoke",
        id: "dup-1",
        tool: ` ${canonicalTool} `,
        args: {},
        sessionId: "logical-1",
        agentId: "agent-2",
      });

      await sleep(80);
      expect(invokeCount).toBe(1);

      releaseGate();

      const outputs = await waitForMessages(
        client.messages,
        (item) => item && item.id === "dup-1" && typeof item.ok === "boolean",
        2,
        3000,
      );
      const [startedEvent] = await waitForMessages(
        client.messages,
        (item) => item?.type === "event" && item?.event === "invoke.started" && item?.id === "dup-1",
        1,
        3000,
      );
      const [finishedWithMetrics] = await waitForMessages(
        client.messages,
        (item) =>
          item?.type === "event" &&
          item?.event === "invoke.finished" &&
          item?.id === "dup-1" &&
          typeof item?.data?.metrics === "object",
        1,
        3000,
      );

      const agentIds = outputs.map((item) => item.agentId).sort();
      expect(agentIds).toEqual(["agent-1", "agent-2"]);
      expect(outputs.every((item) => item.sessionId === "logical-1")).toBe(true);
      expect(outputs.every((item) => item.ok === true)).toBe(true);
      expect(startedEvent.data?.tool).toBe(canonicalTool);
      expect(startedEvent.data?.canonicalTool).toBe(canonicalTool);
      expect(finishedWithMetrics.data?.metrics?.tool).toBe(canonicalTool);
    } finally {
      await client.close();
      await server.stop(true);
      unregisterInvokeToolHandler(canonicalTool);
      unregisterToolContract(canonicalTool);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("duplicate invoke id with mismatched args should fail instead of reusing wrong result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-server-dedup-conflict-"));
    const canonicalTool = "test.dedup.guard";
    const port = await getFreePort();
    const config = createTestConfig(root, port, 4);

    let invokeCount = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    registerToolContract({ name: canonicalTool }, { replace: true });
    registerInvokeToolHandler(
      canonicalTool,
      async (req) => {
        invokeCount += 1;
        await gate;
        return { value: req.args.value };
      },
      { replace: true },
    );

    const server = startBridgeServer({ config });
    const wsUrl = `ws://${config.host}:${server.port}/ws?token=${config.token}`;
    const client = await connectWs(wsUrl);

    try {
      client.send({
        type: "invoke",
        id: "conflict-1",
        tool: canonicalTool,
        args: { value: "a" },
        sessionId: "logical-conflict",
        agentId: "agent-a",
      });

      await waitForMessages(
        client.messages,
        (item) => item?.type === "event" && item?.event === "invoke.started" && item?.id === "conflict-1",
        1,
        3000,
      );

      client.send({
        type: "invoke",
        id: "conflict-1",
        tool: canonicalTool,
        args: { value: "b" },
        sessionId: "logical-conflict",
        agentId: "agent-b",
      });

      const [firstConflict] = await waitForMessages(
        client.messages,
        (item) =>
          item &&
          item.id === "conflict-1" &&
          item.ok === false &&
          item.error?.code === "E_ARGS" &&
          item.agentId === "agent-b",
        1,
        3000,
      );
      expect(String(firstConflict.error?.message || "")).toContain("duplicate invoke id");

      releaseGate();
      await waitForMessages(
        client.messages,
        (item) => item && item.id === "conflict-1" && item.ok === true && item.agentId === "agent-a",
        1,
        3000,
      );
      expect(invokeCount).toBe(1);

      client.send({
        type: "invoke",
        id: "conflict-1",
        tool: canonicalTool,
        args: { value: "b" },
        sessionId: "logical-conflict",
        agentId: "agent-c",
      });

      await waitForMessages(
        client.messages,
        (item) =>
          item &&
          item.id === "conflict-1" &&
          item.ok === false &&
          item.error?.code === "E_ARGS" &&
          item.agentId === "agent-c",
        1,
        3000,
      );
      expect(invokeCount).toBe(1);

      client.send({
        type: "invoke",
        id: "conflict-1",
        tool: canonicalTool,
        args: { value: "a" },
        sessionId: "logical-conflict",
        agentId: "agent-d",
      });

      await waitForMessages(
        client.messages,
        (item) => item && item.id === "conflict-1" && item.ok === true && item.agentId === "agent-d",
        1,
        3000,
      );
      expect(invokeCount).toBe(1);
    } finally {
      await client.close();
      await server.stop(true);
      unregisterInvokeToolHandler(canonicalTool);
      unregisterToolContract(canonicalTool);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("E_BUSY response carries logical session id consistently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-server-busy-"));
    const canonicalTool = "test.block.busy";
    const port = await getFreePort();
    const config = createTestConfig(root, port, 1);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    registerToolContract({ name: canonicalTool }, { replace: true });
    registerInvokeToolHandler(
      canonicalTool,
      async () => {
        await gate;
        return { from: canonicalTool };
      },
      { replace: true },
    );

    const server = startBridgeServer({ config });
    const wsUrl = `ws://${config.host}:${server.port}/ws?token=${config.token}`;
    const client = await connectWs(wsUrl);

    try {
      client.send({
        type: "invoke",
        id: "hold-1",
        tool: canonicalTool,
        args: {},
        sessionId: "logical-busy",
        agentId: "agent-hold",
      });

      await waitForMessages(
        client.messages,
        (item) => item?.type === "event" && item?.event === "invoke.started" && item?.id === "hold-1",
        1,
        3000,
      );

      client.send({
        type: "invoke",
        id: "busy-2",
        tool: canonicalTool,
        args: {},
        sessionId: "logical-busy",
        agentId: "agent-busy",
      });

      const [busyOut] = await waitForMessages(
        client.messages,
        (item) => item && item.id === "busy-2" && item.ok === false,
        1,
        3000,
      );

      expect(busyOut.error?.code).toBe("E_BUSY");
      expect(busyOut.sessionId).toBe("logical-busy");
      expect(busyOut.agentId).toBe("agent-busy");
      expect(busyOut.error?.details?.logicalSessionId).toBe("logical-busy");

      releaseGate();
      await waitForMessages(
        client.messages,
        (item) => item && item.id === "hold-1" && item.ok === true,
        1,
        3000,
      );
    } finally {
      await client.close();
      await server.stop(true);
      unregisterInvokeToolHandler(canonicalTool);
      unregisterToolContract(canonicalTool);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("audit write failure degrades gracefully and remains observable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-server-audit-"));
    const canonicalTool = "test.audit.safe";
    const port = await getFreePort();
    const config = createTestConfig(root, port, 2);

    let auditAttempts = 0;
    const failingAudit = {
      async log() {
        auditAttempts += 1;
        throw new Error("audit write failed");
      },
    };

    registerToolContract({ name: canonicalTool }, { replace: true });
    registerInvokeToolHandler(
      canonicalTool,
      async () => {
        return { ok: true };
      },
      { replace: true },
    );

    const server = startBridgeServer({ config, auditLogger: failingAudit });
    const wsUrl = `ws://${config.host}:${server.port}/ws?token=${config.token}`;
    const client = await connectWs(wsUrl);

    try {
      client.send({
        type: "invoke",
        id: "audit-1",
        tool: canonicalTool,
        args: {},
        sessionId: "logical-audit",
        agentId: "agent-audit",
      });

      const [out] = await waitForMessages(
        client.messages,
        (item) => item && item.id === "audit-1" && typeof item.ok === "boolean",
        1,
        3000,
      );
      expect(out.ok).toBe(true);
      expect(out.sessionId).toBe("logical-audit");
      expect(out.agentId).toBe("agent-audit");

      const [stderrEvent] = await waitForMessages(
        client.messages,
        (item) =>
          item?.type === "event" &&
          item?.event === "invoke.stderr" &&
          item?.id === "audit-1" &&
          String(item?.data?.chunk || "").includes("[bridge.audit] failed to persist audit"),
        1,
        3000,
      );
      expect(stderrEvent?.event).toBe("invoke.stderr");
      expect(stderrEvent?.data?.source).toBe("audit");
      expect(auditAttempts).toBeGreaterThan(0);
    } finally {
      await client.close();
      await server.stop(true);
      unregisterInvokeToolHandler(canonicalTool);
      unregisterToolContract(canonicalTool);
      await rm(root, { recursive: true, force: true });
    }
  });
});
