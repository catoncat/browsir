import "./test-setup";

import { describe, expect, it } from "vitest";
import { BrainOrchestrator } from "../orchestrator.browser";
import { createRuntimeLoopController, CAPABILITIES } from "../runtime-loop.browser";
import {
  syncConfiguredMcpServers,
  syncMcpServerTools,
} from "../mcp-tool-materializer";
import type { RuntimeInfraHandler, RuntimeInfraResult } from "../runtime-infra.browser";

type InfraCall = Record<string, unknown>;

function createMockInfra(options: {
  discoveredTools?: Array<Record<string, unknown>>;
} = {}) {
  const calls: InfraCall[] = [];
  const discoveredTools = options.discoveredTools || [
    {
      name: "echo",
      title: "Echo Tool",
      description: "Echoes the provided text.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  ];
  const infra: RuntimeInfraHandler = {
    async handleMessage(message: unknown): Promise<RuntimeInfraResult | null> {
      const msg = (message || {}) as Record<string, unknown>;
      calls.push(msg);
      if (String(msg.type || "") !== "bridge.invoke") {
        return { ok: true, data: {} };
      }
      const payload = ((msg.payload || {}) as Record<string, unknown>) || {};
      if (String(payload.tool || "") === "mcp_list_tools") {
        return {
          ok: true,
          data: {
            ok: true,
            data: {
              serverId: "fixture-stdio",
              tools: discoveredTools,
            },
          },
        };
      }
      if (String(payload.tool || "") === "mcp_call_tool") {
        const args = ((payload.args || {}) as Record<string, unknown>) || {};
        const toolArgs = ((args.arguments || {}) as Record<string, unknown>) || {};
        return {
          ok: true,
          data: {
            ok: true,
            data: {
              serverId: "fixture-stdio",
              toolName: "echo",
              isError: false,
              content: [
                {
                  type: "text",
                  text: `echo:${String(toolArgs.text || "")}`,
                },
              ],
              structuredContent: {
                echoed: String(toolArgs.text || ""),
              },
            },
          },
        };
      }
      if (String(payload.tool || "") === "mcp_disconnect_server") {
        return {
          ok: true,
          data: {
            ok: true,
            data: {
              serverId: String(
                ((((payload.args || {}) as Record<string, unknown>).serverId ||
                  "") as string),
              ),
              closed: true,
            },
          },
        };
      }
      return { ok: true, data: { ok: true, data: {} } };
    },
    disconnectBridge() {},
    abortBridgeInvokesBySession() {
      return 0;
    },
  };
  return { infra, calls };
}

describe("mcp.browser", () => {
  it("syncs discovered MCP tools into dynamic tool contracts", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    orchestrator.upsertMcpServer({
      id: "fixture-stdio",
      enabled: true,
      transport: "stdio",
      command: "bun",
      args: ["./fixture.ts"],
    });

    const synced = await syncMcpServerTools({
      orchestrator,
      infra: mock.infra,
      serverId: "fixture-stdio",
    });

    expect(synced.toolNames).toEqual(["mcp__fixture_stdio__echo"]);
    expect(
      orchestrator
        .listToolContracts()
        .some((item) => item.name === "mcp__fixture_stdio__echo"),
    ).toBe(true);
    expect(orchestrator.getMcpDiscoveredTools()).toHaveLength(1);
  });

  it("routes mcp.call capability through bridge mcp_call_tool", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    orchestrator.upsertMcpServer({
      id: "fixture-stdio",
      enabled: true,
      transport: "stdio",
      command: "bun",
      args: ["./fixture.ts"],
    });
    await syncMcpServerTools({
      orchestrator,
      infra: mock.infra,
      serverId: "fixture-stdio",
    });

    const result = await orchestrator.executeStep({
      sessionId: "mcp-session",
      capability: CAPABILITIES.mcpCall,
      action: "mcp__fixture_stdio__echo",
      args: {
        text: "hello-runtime",
      },
      verifyPolicy: "off",
    });

    expect(result.ok).toBe(true);
    expect(result.modeUsed).toBe("bridge");
    expect(result.capabilityUsed).toBe(CAPABILITIES.mcpCall);

    const bridgeCalls = mock.calls.filter(
      (item) => String(item.type || "") === "bridge.invoke",
    );
    const mcpCall = bridgeCalls.find(
      (item) =>
        String(
          (((item.payload || {}) as Record<string, unknown>).tool || ""),
        ) === "mcp_call_tool",
    );
    expect(mcpCall).toBeTruthy();
    const payload = (((mcpCall?.payload || {}) as Record<string, unknown>)
      .args || {}) as Record<string, unknown>;
    expect(String(payload.toolName || "")).toBe("echo");
    expect(((payload.arguments || {}) as Record<string, unknown>).text).toBe(
      "hello-runtime",
    );
  });

  it("reconciles stored MCP server config into active tool contracts", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    await syncConfiguredMcpServers({
      orchestrator,
      infra: mock.infra,
      servers: [
        {
          id: "fixture stdio",
          label: "Fixture",
          enabled: true,
          transport: "stdio",
          command: "bun",
          args: ["./fixture.ts"],
        },
      ],
      refresh: true,
    });

    expect(
      orchestrator
        .listToolContracts()
        .some((item) => item.name === "mcp__fixture_stdio__echo"),
    ).toBe(true);

    await syncConfiguredMcpServers({
      orchestrator,
      infra: mock.infra,
      servers: [],
    });

    expect(
      orchestrator
        .listToolContracts()
        .some((item) => item.name === "mcp__fixture_stdio__echo"),
    ).toBe(false);

    const disconnectCalls = mock.calls.filter((item) => {
      if (String(item.type || "") !== "bridge.invoke") return false;
      const payload = (item.payload || {}) as Record<string, unknown>;
      return String(payload.tool || "") === "mcp_disconnect_server";
    });
    expect(disconnectCalls).toHaveLength(1);
    expect(
      String(
        (
          (((disconnectCalls[0]?.payload || {}) as Record<string, unknown>)
            .args || {}) as Record<string, unknown>
        ).serverId || "",
      ),
    ).toBe("fixture_stdio");
  });

  it("disconnects bridge session when a server is disabled", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra();
    createRuntimeLoopController(orchestrator, mock.infra);

    await syncConfiguredMcpServers({
      orchestrator,
      infra: mock.infra,
      servers: [
        {
          id: "fixture stdio",
          label: "Fixture",
          enabled: true,
          transport: "stdio",
          command: "bun",
          args: ["./fixture.ts"],
        },
      ],
    });

    await syncConfiguredMcpServers({
      orchestrator,
      infra: mock.infra,
      servers: [
        {
          id: "fixture stdio",
          label: "Fixture",
          enabled: false,
          transport: "stdio",
          command: "bun",
          args: ["./fixture.ts"],
        },
      ],
    });

    const disconnectCalls = mock.calls.filter((item) => {
      if (String(item.type || "") !== "bridge.invoke") return false;
      const payload = (item.payload || {}) as Record<string, unknown>;
      return String(payload.tool || "") === "mcp_disconnect_server";
    });
    expect(disconnectCalls).toHaveLength(1);
  });

  it("rejects discovered MCP tools whose normalized names collide", async () => {
    const orchestrator = new BrainOrchestrator();
    const mock = createMockInfra({
      discoveredTools: [
        {
          name: "foo-bar",
          title: "Foo Bar",
          description: "First",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "foo_bar",
          title: "Foo Bar 2",
          description: "Second",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    createRuntimeLoopController(orchestrator, mock.infra);

    orchestrator.upsertMcpServer({
      id: "fixture-stdio",
      enabled: true,
      transport: "stdio",
      command: "bun",
      args: ["./fixture.ts"],
    });

    await expect(
      syncMcpServerTools({
        orchestrator,
        infra: mock.infra,
        serverId: "fixture-stdio",
      }),
    ).rejects.toThrow("MCP tool 名规范化冲突");
  });
});
