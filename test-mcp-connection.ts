#!/usr/bin/env bun
/**
 * 测试 copilot-enhance-3211 MCP server 连接
 * 用法：bun test-mcp-connection.ts
 */

const MCP_URL = "http://127.0.0.1:3211/mcp";

async function testConnection() {
  console.log("🔍 测试 MCP server 连接:", MCP_URL);
  
  try {
    // 尝试发起一个简单的 HTTP GET 请求检查服务是否存活
    const response = await fetch(MCP_URL, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });
    
    console.log("✅ HTTP 连接成功");
    console.log("状态码:", response.status);
    console.log("响应头:", Object.fromEntries(response.headers.entries()));
    
    const text = await response.text();
    if (text) {
      console.log("响应内容:", text.slice(0, 500));
    }
  } catch (error) {
    console.error("❌ 连接失败:", error.message);
    console.error("请确认 MCP server 已启动并运行在 http://127.0.0.1:3211/mcp");
  }
}

testConnection();
