# BDD 交接文档（当前基线）

更新时间：2026-03-15
仓库路径：`/Users/envvar/work/repos/browser-brain-loop`

## 1. 当前状态

- 内核运行时已收口到 `extension/src/sw/kernel/*`，`extension/service-worker.js` 仅为 shim 入口。
- BDD 已从"单一门禁"升级为"分类门禁"（6 分类）。
- Kernel 引擎 50 模块，聚合在 `BrainOrchestrator` 单例。
- 46 个内置工具契约。

### 近期重大进展（2026-03-14 ~ 2026-03-15）

**已完成：**

| ISSUE | 标题 | 提交 | 状态 |
|-------|------|------|------|
| ISSUE-017 | ChatView 主控拆分 | `9501a7b` | done |
| ISSUE-018 | Runtime Loop LLM 请求提取 | `aae8421` | done |
| ISSUE-019 | System Prompt Resolver 提取 | `eb175fe` | done |
| ISSUE-020 | Terminal/Failure/Agent-end 域统一 | `c81ff08` | done |
| ISSUE-022 | 浏览器自动化 AIPex 对齐 | 多次提交 | done |
| ISSUE-025 | Cursor Help pool 心跳 | `421058c` | done |
| ISSUE-026 | Lane 并发冲突细化 | `a444abe`, `158dba6` | done |
| ISSUE-027 | 窗口行为优化 | `8c85676`, `9aa1a79` 等 | done |
| ISSUE-028 | Sandbox Runtime 归一化 Phase 2-5 | `d2d7733`~`252d5e7` | done |
| ISSUE-029 | Prompt Policy Phase 6 | `694b97c`, `ce58b87` | done |

**进行中：**

| ISSUE | 标题 | 负责 | 说明 |
|-------|------|------|------|
| ISSUE-023 | Cursor Help Pool 架构 (Epic) | human | Provider 连通性恢复 |
| ISSUE-024 | Cursor Help pool 自动扩缩容 | agent | 刚启动，依赖 025/026 |

**待启动：**

| ISSUE | 标题 | 说明 |
|-------|------|------|
| ISSUE-021 | ChatView 二阶段深拆 | 前置 ISSUE-017 已 done |

### 调试基础设施

- CDP 直连工具 `tools/cdp-debug.ts` 已落地（targets/screenshot/dom/eval/chat/sw-eval/serve 模式）
- Bridge HTTP 诊断 API 可用
- AI 三层调试模型：L1(CDP) / L2(Bridge API) / L3(自动化)

## 2. 本轮基线文件

- 契约：`bdd/contracts/**/*.json`
- 契约分类：`bdd/mappings/contract-categories.json`
- 契约映射：`bdd/mappings/contract-to-tests.json`
- 规则说明：`bdd/README.md`
- 写作规范：`bdd/CONTRACT-WRITING-GUIDELINE.md`

## 3. 门禁命令（续跑先执行）

```bash
bun run bdd:validate
bun run bdd:gate
bun run bdd:gate:orchestrator
bun run bdd:gate:runtime-loop
bun run bdd:gate:cdp
bun run bdd:gate:llm
bun run bdd:gate:session
bun run bdd:gate:panel
```

如需联动运行证据：

```bash
BRAIN_E2E_HEADLESS=true bun run brain:e2e
bun run bdd:gate
```

live profile：

```bash
bun run brain:e2e:live
bun run bdd:gate:live
```

## 4. 交接重点

1. 新增/修改契约时，必须同步更新：
   - `bdd/mappings/contract-categories.json`
   - `bdd/mappings/contract-to-tests.json`
2. 优先写“行为语义”，避免绑定内部变量名、私有 debug 路径、具体函数路径。
3. 若只改某一分类，可先跑对应的 `bdd:gate:<category>`；合并前仍需跑全量 `bdd:gate`。

## 5. 下一步建议（按优先级）

1. 继续清理高耦合契约措辞（实现细节 -> 行为语义）。
2. 将 `e2e` selector 覆盖扩展到更多 high-risk 契约。
3. 在 CI 按 `orchestrator/runtime-loop/cdp/llm/session/panel` 分类并行 gate，缩短反馈时间。

