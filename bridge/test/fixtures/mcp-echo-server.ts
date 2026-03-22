import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "fixture-mcp-echo-server",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    title: "Echo Tool",
    description: "Echoes the provided text.",
    inputSchema: {
      text: z.string().describe("Text to echo"),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
    structuredContent: {
      echoed: text,
    },
  }),
);

server.registerTool(
  "sum",
  {
    title: "Sum Tool",
    description: "Adds two numbers.",
    inputSchema: {
      a: z.number().describe("First operand"),
      b: z.number().describe("Second operand"),
    },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: {
      sum: a + b,
    },
  }),
);

await server.connect(new StdioServerTransport());
