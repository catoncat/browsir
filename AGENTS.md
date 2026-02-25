## 项目概述

Browser Brain Loop：浏览器侧 AI Agent 系统。大脑（Planner + Loop Engine）运行在 Chrome 扩展的 SidePanel / Service Worker 中，本地 Bun WebSocket 服务（Bridge）仅做执行代理，提供 `read/write/edit/bash` 四个工具。

**架构铁律：大脑永远在浏览器侧，本地 WS 只做执行代理，不做任务决策。**

## 外部参考仓库（LLM Provider）

- Pi monorepo 固定位置：`~/work/repos/_research/pi-mono/`
- 后续涉及 “LLM Provider 兼容 / 自动注册 / 多模型上下文切换” 时，默认先看：
  - `~/work/repos/_research/pi-mono/packages/ai/`
  - `~/work/repos/_research/pi-mono/packages/coding-agent/src/core/model-registry.ts`
  - `~/work/repos/_research/pi-mono/packages/coding-agent/docs/custom-provider.md`
  - `~/work/repos/_research/pi-mono/packages/ai/src/providers/transform-messages.ts`

## 常用命令

```bash
# 一键开发（bridge + extension watcher）
BRIDGE_TOKEN="<token>" bun run brain:dev

# 单独启动 bridge
cd bridge && bun install && BRIDGE_TOKEN="<token>" bun run start

# 扩展热重载 watcher（文件变化自动 bump bridge 版本触发 chrome.runtime.reload）
BRIDGE_TOKEN="<token>" bun run brain:ext:watch

# Bridge 类型检查 + 单元测试
bun run check:brain-bridge          # = cd bridge && bun run typecheck && bun run test

# 单跑 bridge 测试
cd bridge && bun test               # 全部
cd bridge && bun test test/fs-guard.test.ts  # 单个文件

# 类型检查
cd bridge && bunx tsc --noEmit

# E2E（纯 CDP，无 Playwright；需 Chrome for Testing 或 Chromium）
bun run brain:e2e
BRIDGE_TOKEN="<token>" bun run brain:e2e:live              # 真实 LLM 冒烟（需下方 LLM 环境变量）
CHROME_BIN="/path/to/chrome" bun run brain:e2e       # 指定浏览器
BRAIN_E2E_HEADLESS=true bun run brain:e2e            # headless 模式

# BDD 契约校验 + 门禁
bun run bdd:validate && bun run bdd:gate
bun run bdd:gate:live                                 # 检查 live profile 契约
```

live LLM 环境变量（用于 `brain:e2e:live`）：

```bash
BRAIN_E2E_LIVE_LLM_BASE="https://ai.chen.rs/v1"
BRAIN_E2E_LIVE_LLM_KEY="<key>"
BRAIN_E2E_LIVE_LLM_MODEL="gpt-5.3-codex"
# 可选：BRAIN_E2E_LIVE_ATTEMPTS=3 BRAIN_E2E_LIVE_MIN_PASS=2
```

## 架构

```
browser-brain-loop/
├── bridge/          # Bun 本地 WS 服务 (ws://127.0.0.1:8787)
│   └── src/
│       ├── server.ts       # Bun.serve WS 入口，认证/并发控制/审计
│       ├── dispatcher.ts   # invoke 分发到 tools/{read,write,edit,bash}
│       ├── config.ts       # 环境变量配置（BridgeConfig）
│       ├── cmd-registry.ts # bash 命令白名单（cmdId → argv 映射）
│       ├── fs-guard.ts     # 文件系统路径守卫（god/strict 模式）
│       ├── protocol.ts     # WS 帧解析 + 类型转换辅助函数
│       └── tools/          # read/write/edit/bash 四个工具实现
├── extension/       # MV3 Chrome 扩展（直接 JS，无构建步骤）
│   ├── service-worker.js  # CDP Gateway + WS Client + 租约管理
│   ├── sidepanel.{html,js} # Planner UI + Loop Engine + 自治修复
│   └── manifest.json
├── bdd/             # 行为契约驱动开发
│   ├── contracts/   # BHV-* 行为契约 JSON
│   ├── features/    # Gherkin .feature 文件（@contract(...) 引用契约）
│   ├── mappings/    # contract-to-tests.json 契约到证明层映射
│   ├── schemas/     # 契约 JSON Schema
│   └── evidence/    # e2e 运行产出的证据 JSON
└── tools/           # 构建/测试/门禁脚本
    ├── brain-e2e.ts      # 纯 CDP e2e 测试
    ├── brain-dev.sh      # 一键开发启动
    ├── brain-ext-watch.ts # 扩展文件变化 → 自动重载
    ├── bdd-validate.ts   # 契约结构校验
    ├── bdd-gate.ts       # 门禁（契约覆盖 + 证据 passed=true）
    └── bdd-lib.ts        # BDD 工具共享库
```

## UI 与无障碍 (Accessibility First)

所有 UI 开发必须遵循以下无障碍标准，确保产品对所有用户（包括辅助技术用户）友好：

- **语义化 HTML**：优先使用 `<header>`, `<main>`, `<nav>`, `<article>`, `<button>`, `<ul>` 等语义标签，避免滥用 `div`。
- **ARIA 属性**：
  - 所有图标按钮必须具备明确的 `aria-label`。
  - 复杂组件必须包含状态描述（`aria-expanded`, `aria-haspopup`, `aria-controls`）。
  - 实时变化区域（如消息列表）必须标记 `role="log"` 和 `aria-live="polite"`。
  - 列表项使用 `role="listitem"`，当前项使用 `aria-current="true"`。
- **键盘导航**：
  - 所有交互元素必须可通过 `Tab` 键聚焦。
  - 核心列表（如会话列表）必须支持 `ArrowUp/ArrowDown` 方向键导航及 `Enter` 确认。
  - 必须确保焦点可见性（使用 `focus-visible` 样式）。
- **图标降噪**：纯装饰性图标必须标记 `aria-hidden="true"`。

## 关键协议

Bridge WS 通信使用统一 `invoke` 帧格式：
- 请求：`{ type: "invoke", id, tool, args, sessionId?, parentSessionId?, agentId? }`
- 成功：`{ id, ok: true, data, sessionId? }`
- 失败：`{ id, ok: false, error: { code, message, details? } }`
- 事件：`{ type: "event", event: "invoke.started|stdout|stderr|finished", ... }`

错误码前缀：`E_PATH`（路径拒绝）、`E_TOOL`（未知工具）、`E_ARGS`（参数错误）、`E_CMD`（命令未白名单）、`E_BUSY`（并发上限）。

## Bridge 模式

- **god**（默认）：文件系统无限制，`bash.exec` 默认启用
- **strict**：需 `BRIDGE_ROOTS` 限制路径范围，命令受 `allowInStrict` 过滤

关键环境变量：`BRIDGE_TOKEN`、`BRIDGE_MODE`、`BRIDGE_ROOTS`、`BRIDGE_PORT`(8787)、`BRIDGE_ENABLE_BASH_EXEC`、`BRIDGE_MAX_CONCURRENCY`(6)。

## BDD 规则

- BDD 索引文档：`bdd/README.md`
- 契约 ID 格式：`BHV-*`，必须唯一
- 每个契约必须被至少一个 `.feature` 的 `@contract(...)` 引用
- 每个契约必须在 `contract-to-tests.json` 有映射且满足 `proof_requirements`
- gate 严格失败：任何缺失/映射不完整/目标路径不存在/`passed!=true` 都失败
- `BDD_GATE_PROFILE=default` 只检查默认契约；`BDD_GATE_PROFILE=live` 额外检查 `context.gate_profile=live` 契约
- 会话中断续跑参考 `bdd/SESSION-HANDOFF.md`

## 扩展侧 CDP API

通过 `chrome.runtime.sendMessage` 调用，四类操作：
- `cdp.snapshot`：A11y-first 快照（text/interactive/full），支持 `filter/format/diff/maxTokens/depth/selector/noAnimations`
- 返回以 `nodes[*].ref/role/name/depth/backendNodeId` 为主，并附带 `compact/truncated/hash/diff`
- `cdp.action`：页面动作（click/type/fill/press/scroll/select/navigate），`ref` 优先 `backendNodeId`
- `cdp.verify`：URL/title/text/selector 断言，支持 `urlChanged(previousUrl)`
- `lease.*`：tab 写操作租约（acquire → action → release）

## Loop 编排约束（实现口径）

- LLM 消费 snapshot 时优先 `compact + 元信息`，不要把整段大 JSON 直接塞回对话。
- LLM 默认配置：`base=https://ai.chen.rs/v1`、`model=gpt-5.3-codex`（key 由运行时注入）。
- strict verify 模式下，`browser_action` 默认需要动作后验证；“执行成功”不等于“目标推进成功”。
- 必须启用 `no_progress` 检测（重复签名 / ping-pong 往返）并提前终止当前轮。
- auto-repair 仅在 `failed_execute/failed_verify/progress_uncertain` 或 `loop_no_progress` 信号触发；`max_steps/stopped/timeout` 不自动续跑下一轮。
- `stopped` 回复优先状态文案，不回显 memory 中的大段 snapshot 内容。
- BDD 必须覆盖 LLM 能力门禁：`tool_call` 闭环成功、无 LLM 的规则降级成功、不可降级时 `failed_execute`、LLM HTTP 失败回退规则 planner。
- BDD 采用双层：默认 profile 用 mock 保证编排稳定；live profile 用真实 LLM 验证浏览器任务成功率（`brain:e2e:live` + `bdd:gate:live`）。

## 技术栈

- 运行时：Bun（bridge）、Chrome MV3（extension）
- 语言：TypeScript（bridge）、纯 JS（extension，无构建步骤）
- 测试：`bun test`（bridge 单元测试）、纯 CDP e2e（无 Playwright）
- 扩展无构建流程，直接加载 `extension/` 目录
