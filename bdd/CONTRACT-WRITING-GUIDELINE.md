# BDD 契约写作规范（去实现耦合）

## 目标

让契约描述“可观察行为”，而不是绑定某个实现细节，从而支持架构演进。

## 契约分类

- `panel`: 用户可感知的面板与交互行为。
- `orchestrator`: 编排器、hook、provider 路由等技术控制面契约。
- `runtime-loop`: loop 编排、tool_call、retry、no-progress 等运行时行为。
- `cdp`: 浏览器执行与验证相关契约。
- `llm`: provider 路由、能力门禁、升级策略相关契约。
- `session`: 会话生命周期、压缩、恢复、标题等会话契约。

分类清单见：`bdd/mappings/contract-categories.json`。

## Feature 分层规则

- `bdd/features/business/**`
  - 仅写业务行为和可观察结果。
  - 不写内部执行对象、协议字段、定位器、测试工件。
- `bdd/features/technical/**`
  - 允许写协议与内部契约语义（例如路由、错误码、存储流程）。
- 分类绑定：
  - `panel -> business`
  - `orchestrator|cdp|llm -> technical`
  - `session|runtime-loop -> business 或 technical（按场景语义选择）`

## 必须遵守

1. 只断言行为，不断言内部变量名。  
反例：`selectedTabIds`；正例：`用户取消引用后不再将该 tab 注入上下文`。

2. 只断言协议语义，不断言文件路径。  
反例：`bootstrapPath=background.sw-main.bootstrapSessionStore`；正例：`启动时检测 legacy 并重置`。

3. 断言可迁移的输出，不断言调试私有字段。  
反例：依赖 `brain.debug.dump` 内部路径；正例：依赖 `brain.session.view` 或公开 response 字段。

4. 对 e2e 证据使用 selector 命中。  
`mappings` 的 e2e target 使用：`bdd/evidence/*.json::测试名关键词`。

5. 风险越高，层数越高。  
`risk=high|critical` 的契约，`min_layers >= 2` 且至少包含 `browser-cdp` 或 `e2e`。

6. business feature 禁止实现细节词。  
反例：`kernel`、`orchestrator`、`cdp.action`、`aria-label`、`data-testid`、`contract-to-tests.json`；  
正例：`用户发起重试后应出现加载反馈，完成后出现新回复`。

## 推荐写法

- `intent`: 一句话描述业务结果。
- `steps`: 采用“触发 -> 执行 -> 验证”。
- `observables`: 写“可验证结果”，避免技术术语。
- `degrade_policy`: 明确失败后的兜底行为。

## 门禁命令

- 语义 lint：`bun run bdd:lint:features`
- 全量：`bun run bdd:gate`
- Orchestrator：`bun run bdd:gate:orchestrator`
- Runtime Loop：`bun run bdd:gate:runtime-loop`
- CDP：`bun run bdd:gate:cdp`
- LLM：`bun run bdd:gate:llm`
- Session：`bun run bdd:gate:session`
- Panel：`bun run bdd:gate:panel`
- Live：`bun run bdd:gate:live`
