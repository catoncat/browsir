# Linux-like 文件上下文引用与内核边界修复设计

日期：2026-03-13

## 1. 背景

当前有两类问题已经开始互相放大：

1. 文件系统上下文还没有成为一等能力。
   - 聊天输入框里的 `@` 目前只接了 tab mention，不支持 `@路径` 文件引用。
   - `sendPrompt()` 只发送 `prompt/tabIds/skillIds/streamingBehavior`，没有结构化文件上下文载荷。
   - system prompt 目前只是整段字符串覆盖，不支持按文件懒加载。
2. 这类能力如果继续直接塞进现有实现，会进一步恶化中层边界。
   - `runtime-loop.browser.ts` 已经同时承担 prompt policy、skills catalog、/skill 展开、builtin capability 调度、loop 执行等多种职责。
   - `runtime-router.ts` 目前既是协议入口，又在承接 session/run/skill/plugin/storage/debug 的控制面。
   - SidePanel 产品层也还没有把“聊天产品面”和“平台控制面”分开，`App.vue` 和 `runtime store` 都在变成超级节点。

这意味着，`@文件路径` 不能只被当成一个输入框小功能来做。它必须被设计成底层的文件上下文引用机制，并且要落在正确边界里，否则只会把 God module 再做厚一层。

## 2. 目标

本设计的目标是同时解决“能力缺失”和“边界漂移”：

1. 建立统一的 `@路径` 文件上下文引用机制，支持 host filesystem 和 browser sandbox filesystem。
2. 用户心智尽量接近真实 Linux 文件系统，而不是让用户直接学习一堆 `mem://` 内部协议细节。
3. `@路径` 不是 prompt include 宏，而是结构化 context reference / attachment。
4. 支持懒加载和预算控制，避免每轮都把整批文件全文塞进 prompt。
5. skills、system prompt、references、未来其他上下文注入能力，都复用同一套 resolver/materializer。
6. 在落这套机制的同时，把 `runtime-loop`、`runtime-router`、SidePanel 的职责重新切开，避免继续堆在单点文件里。

## 3. 非目标

以下内容不在本设计的 v1 目标内：

1. 不做新的 prompt DSL，不引入 `{{include}}`、`#import` 这类模板语言。
2. 不做“自动猜文件并偷偷注入”的黑盒行为，显式引用优先。
3. 不改变 skills 的行业标准结构。`SKILL.md + scripts/ + references/ + assets/` 仍然成立。
4. 不把整个 SidePanel 一次性重写成新框架。只做边界重排和壳层收口。
5. 不把 Bridge 变成 planner 或 context assembler。大脑仍然在浏览器侧。

## 4. 设计原则

### 4.1 文件系统优先，Prompt 次之

`@路径` 的本质是“引用文件系统里的对象”，不是“往 prompt 里做字符串替换”。

先有：

- 路径解析
- 对象分类
- 预算化 materialize
- 结构化上下文索引

然后才有 prompt 组装。

### 4.2 用户语义是 Linux-like，内部语义是 canonical URI

对用户：

- 应尽量像真实路径：`@/abs/path`、`@./rel/path`、`@~/path`
- browser sandbox 提供一个稳定挂载视图：`@/mem/...`

对内部：

- browser sandbox 仍以 `mem://...` 作为 canonical URI
- host filesystem 仍以绝对路径作为 canonical locator

也就是说：

- `/mem/...` 是用户面 mount
- `mem://...` 是内核面 canonical

`mem://` 继续存在，但不再是主要用户心智。

### 4.3 显式引用是结构化 attachment，不是纯文本拼接

模型不应该自己解析 `@foo/bar.ts` 再幻想读取结果。

宿主必须在进入 LLM 前完成：

1. parse
2. resolve
3. classify
4. materialize
5. build context index

最终给模型的是结构化上下文，而不是一串尚未解释的 include token。

### 4.4 懒加载必须真实生效

“把很多文件路径列出来，再把全文照样拼进去”不叫懒加载。

真正有效的懒加载必须满足：

1. 默认只注入索引和小体量内容。
2. 大文件、大目录、二进制默认只给结构化摘要。
3. 模型如需继续深入，再用现有 `host_read_file` / `browser_read_file` 精读。
4. 同一轮和相邻轮需要 dedupe，避免重复吃同一份上下文。

### 4.5 边界修复优先于功能堆叠

`@路径` 相关逻辑不能继续直接堆在：

- `runtime-loop.browser.ts`
- `runtime-router.ts`
- `App.vue`
- `runtime.ts`

否则功能会做出来，但系统会更难演进。

## 5. 当前事实与设计约束

### 5.1 当前已有事实

1. skills catalog 已经是轻量元数据注入，而不是默认加载完整 `SKILL.md`。
2. `/skill:` 显式触发时，完整 skill prompt block 才会进入上下文。
3. `ChatInput.vue` 已经有 `@` mention 入口，但当前实现只服务 tab 选择。
4. `runtime.ts::sendPrompt()` 还没有显式 `contextRefs` 载荷。
5. `llmSystemPromptCustom` 目前是整段 raw string，system prompt 构建仍然是同步拼接。
6. browser VFS 现有 canonical 协议是 `mem://`，这层不应该被推翻。

### 5.2 新设计必须遵守的约束

1. 大脑仍然在浏览器侧，Bridge 不参与 context planning。
2. skills 标准不变：
   - catalog metadata 常驻可见
   - 完整 `SKILL.md` 按需加载
3. `@路径` 要与真实系统上的 agent 使用体验接近。
4. 不做 legacy/fallback 方案扩展。

### 5.3 Phase 0 前置约束

在进入任何 `@路径` 用户面实现之前，必须先钉死以下 4 个前提；任何一项未完成，都不允许进入 Phase 1：

1. session working context 必须类型化，不能继续依赖泛化 `cwd`。
2. host 侧必须具备干净的 metadata primitive，不能靠 `bash.exec` 旁路做 stat/list。
3. `execute_skill_script` 必须和“skills 是 browser scope 资源”这一前提闭环一致。
4. v1 用户面只允许 `/mem/...`，不允许把 `mem://...` 暴露回普通聊天输入。

这 4 点不是“后面慢慢补”的优化项，而是 Phase 0 gate。

### 5.4 SessionWorkingContext 数据模型

当前 `SessionHeader.cwd?: string` 语义过于模糊，不能承担 `@./foo.ts` 的解析基线。

目标态：

```ts
type SessionWorkingContext = {
  hostCwd?: string;
  browserCwd: "mem://";
  browserUserMount: "/mem";
};

interface SessionHeader {
  type: "session";
  version: 1;
  id: string;
  parentSessionId: string | null;
  timestamp: string;
  workingContext?: SessionWorkingContext;
  title?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}
```

约束：

1. `hostCwd` 是唯一允许参与 host 相对路径解析的字段。
2. `browserCwd` v1 固定为 `mem://`，不引入第二套 browser 相对路径语义。
3. `browserUserMount` v1 固定为 `/mem`，作为唯一用户面挂载点。
4. 旧的 `cwd` 视为遗留字段，不得继续扩展或作为新设计基线。

### 5.5 Host Metadata Primitive

`ContextRefService` 在 resolve 阶段必须能做：

1. existence
2. file / directory / missing 分类
3. size / mtime 等基础 metadata
4. directory shallow list

仅靠当前 `read/write/edit/bash` 的 agent-facing 工具语义，无法干净完成这件事。

目标态：

1. 保持对模型可见的 Bridge 工具面不变：
   - `read`
   - `write`
   - `edit`
   - `bash`
2. 为内核私用能力新增 host metadata primitive：
   - `stat`
   - `list`
3. 这两个 primitive 只供浏览器内核使用：
   - `ContextRefService`
   - skill discover / skill resolver
   - diagnostics / inspect
4. 它们不是新的 LLM tool contract，不直接暴露给模型。

### 5.6 Skill Script 执行闭环

文档基线必须与“skills 是 browser scope 资源”保持一致。

目标态：

1. `SKILL.md`、`references/`、`assets/`、`scripts/` 都位于 browser scope。
2. `/skill` 的正文装载继续走 browser scope resolver。
3. skill 触发后的普通 tool calls，继续按既有 capability/provider 路由决定执行 scope。
4. `execute_skill_script` 作为特定 helper tool，必须能直接执行 `mem://skills/.../scripts/...` 下的脚本，不能要求用户先迁到 host path。

v1 约束：

1. `execute_skill_script` 对 skill-bundled script 采用 browser-native 执行。
2. 不允许出现“当前脚本位于虚拟文件系统，无法直接执行，请迁到 host path”这一产品语义。
3. 如果某脚本类型在 browser runtime 暂不支持，应返回明确的 runtime unsupported 错误，而不是要求用户手动迁移路径。

### 5.7 `/mem` 是 v1 唯一用户面语法

v1 明确收口：

1. 普通聊天输入里的 browser sandbox 路径只允许 `/mem/...`
2. `mem://...` 仅允许出现在：
   - 内核 canonical URI
   - 开发者面
   - 调试/诊断输出
   - 内部协议与测试
3. 如果用户在聊天输入显式写 `@mem://...`，v1 直接给可纠正错误：
   - “浏览器沙盒路径请使用 `@/mem/...`”

## 6. 用户面语义

### 6.1 支持的路径输入

聊天中显式 `@路径` 的首批支持语法：

| 用户输入 | 语义 | 内部解析 |
| --- | --- | --- |
| `@/Users/a/project/README.md` | host 绝对路径 | host absolute path |
| `@./src/index.ts` | host 相对路径 | 相对 `session.workingContext.hostCwd` |
| `@../docs/spec.md` | host 相对路径 | 相对 `session.workingContext.hostCwd` |
| `@~/work/foo.md` | host home 路径 | 展开为 host absolute path |
| `@/mem/skills/x/SKILL.md` | browser sandbox 挂载路径 | `mem://skills/x/SKILL.md` |

### 6.2 路径解析规则

1. `/mem/...` 优先视为 browser sandbox。
2. `/...`、`~/...`、`./...`、`../...` 默认走 host path resolver。
3. 相对路径必须依赖 `session.workingContext.hostCwd`。
4. 如果当前会话没有稳定的 `hostCwd`，相对 host path 直接报显式错误，不做猜测。
5. `mem://...` 不是普通聊天输入的合法用户语法；仅作为内核 canonical URI 存在。

### 6.3 `@` 触发行为

`@` 输入不再只绑定 tab provider，而是变成统一 mention gateway。

provider 判定规则：

1. 如果 token 呈现“路径形态”，优先走 file provider。
2. 如果 token 不是路径形态，保留现有 tab provider 行为。
3. 未来 skills / sessions / saved prompts 若接入，也只能作为 mention provider，不得绕过文件引用主模型。

“路径形态”指：

- 以 `/`、`.`、`~` 开头
- 或由文件选择器显式注入

这样可以避免 `@路径` 和现有 tab mention 互相打架。

## 7. 核心数据模型

```ts
type ContextRefTarget =
  | { runtime: "host"; path: string }
  | { runtime: "browser"; uri: string };

type ContextRef = {
  id: string;
  raw: string;
  displayPath: string;
  target: ContextRefTarget;
  source: "composer_mention" | "prompt_parser" | "system_prompt" | "skill_reference";
  kind: "file" | "directory" | "binary" | "missing" | "invalid";
  mime?: string;
  sizeBytes?: number;
};

type MaterializedContextRef = {
  refId: string;
  mode: "full" | "excerpt" | "index" | "metadata_only" | "error";
  summary?: string;
  content?: string;
  truncated?: boolean;
};
```

关键点：

1. `ContextRef` 是“已解析引用”，不是原始字符串。
2. `displayPath` 服务用户心智。
3. `target` 服务工具调用和内核。
4. `mode` 体现懒加载是否真的生效。

## 8. 两阶段流程：Resolve / Materialize

### 8.1 Resolve

resolve 阶段负责：

1. 从输入文本和 mention chips 提取 `@路径`
2. 规范化路径
3. 区分 host/browser runtime
4. 通过 inspect primitive / VFS metadata provider 检查对象是否存在
5. 获取基础元信息
6. 去重

resolve 只产出“对象引用”，不决定是否全文注入。

### 8.2 Materialize

materialize 阶段负责把 resolved ref 转成可送模型的上下文块。

v1 默认策略：

1. 小文本文件：全文 inline
   - 建议阈值：`<= 12 KB`
2. 中文本文件：摘要 + excerpt
   - 建议阈值：`12 KB ~ 64 KB`
   - 只送结构化摘要和有限片段，不送全文
3. 大文本文件：index only
   - 建议阈值：`> 64 KB`
4. 目录：只送浅层目录索引
5. 二进制：只送 metadata

这套策略的目的不是“替模型读完整 repo”，而是：

1. 让显式引用的文件进入模型可见域
2. 避免全文爆 prompt
3. 给模型一个准确入口，让它后续用读文件工具深挖

## 9. Prompt 装配方式

### 9.1 不再做纯文本 include

目标态的 prompt 装配顺序是：

1. system prompt
2. tool policy / retry policy
3. skills catalog metadata
4. context index block
5. materialized context blocks
6. cleaned user prompt

其中：

- `context index block` 是索引
- `materialized context blocks` 是预算化内容
- `cleaned user prompt` 是去掉 `@路径 token` 后的自然语言正文

### 9.2 Context Index 形态

示意：

```xml
<context_index>
  <ref id="ctx_1" path="/mem/skills/fy/SKILL.md" runtime="browser" kind="file" mode="excerpt" />
  <ref id="ctx_2" path="/Users/envvar/work/repos/browser-brain-loop/README.md" runtime="host" kind="file" mode="full" />
</context_index>
```

示意内容块：

```xml
<context_ref id="ctx_2" path="/Users/envvar/work/repos/browser-brain-loop/README.md" mode="full">
...content...
</context_ref>
```

这样做的好处：

1. 模型能知道“有哪些上下文被附带进来”
2. 模型能知道“哪些只是索引，哪些已给全文”
3. 对齐 attachment 语义，而不是偷做字符串 include

## 10. 与 Skills / System Prompt 的关系

### 10.1 Skills

skills 不被这套机制取代，但会复用它。

继续保持：

1. skills catalog metadata 常驻可见
2. 完整 `SKILL.md` 按需加载
3. `/skill:` 是强选择入口

复用点：

1. skill 的 `location`
2. `references/` 下的局部引用
3. 未来 skill 内部相对路径解析

也就是说，skills 是这套文件系统上下文机制的消费者，而不是另一套并行语法。

### 10.2 System Prompt

`llmSystemPromptCustom` 不应再只是“整段大文本”。

目标态：

1. 配置中继续保留文本入口，兼容简单用户
2. 同时支持在 prompt 文本里显式引用 `@路径`
3. system prompt 的 `@路径` 也走同一个 resolve/materialize pipeline
4. system prompt 使用独立预算，避免把用户消息预算吃掉

这让“系统提示词存到 mem 文件里，再引用进来”成为自然能力，而不是单独再设计一套 include 语法。

### 10.3 Skill Script

这套设计与 skill script 的边界必须明确：

1. `@路径` 是上下文引用能力，不直接等于“执行脚本”。
2. skill package 的 `scripts/` 依然属于 browser scope 文件系统对象，因此也可以被 `@/mem/...` 引用为上下文。
3. `execute_skill_script` 则是一个单独的执行能力，它读取的对象来源于同一 filesystem resolver，但执行路径必须是 browser-native。

也就是说：

1. 上下文装载和脚本执行，共享同一套路径解析与资源定位。
2. 但“把脚本内容附带给模型看”和“真正执行脚本”是两条不同链路。
3. 这两条链路都不能把 skill 资源强行迁回 host path。

## 11. Kernel 边界修复

`@路径` 功能的正确落点不是继续加进现有 God module，而是顺手把边界修回来。

### 11.1 Runtime Loop 拆分

当前 `runtime-loop.browser.ts` 承担了过多职责。目标拆分为：

| 目标模块 | 职责 |
| --- | --- |
| `loop/loop-engine.browser.ts` | 轮次状态机、retry、no_progress、step orchestration |
| `prompt/prompt-policy.browser.ts` | system prompt、tool policy、skills catalog、message assembly |
| `context-ref/context-ref-service.browser.ts` | parse、resolve、materialize、context index build |
| `skills/skill-command.browser.ts` | `/skill:` 解析与显式 skill prompt block 生成 |
| `capabilities/builtin-capability-registry.browser.ts` | builtin capability / provider 注册 |

要求：

1. 对外仍保留 `createRuntimeLoopController()` facade，避免一次性炸全工程。
2. `buildLlmMessagesFromContext()` 迁到 prompt policy 模块，并允许 async。
3. context ref 逻辑完全不进入 loop state machine。

### 11.2 Runtime Router 拆分

`runtime-router.ts` 应退回“协议入口 + dispatch”。

目标拆分为：

| 目标模块 | 职责 |
| --- | --- |
| `runtime-router.ts` | 消息入口、schema check、hook、dispatch table |
| `runtime-router/run-controller.ts` | `brain.run.*` |
| `runtime-router/session-controller.ts` | `brain.session.*` |
| `runtime-router/skill-controller.ts` | `brain.skill.*` |
| `runtime-router/plugin-controller.ts` | `brain.plugin.*` |
| `runtime-router/debug-controller.ts` | `brain.debug.*` |
| `runtime-router/storage-controller.ts` | `brain.storage.*` |

原则：

1. router 只做 transport/protocol concerns。
2. domain behavior 放到 controller/service。
3. plugin sandbox runner 不再和普通 run/session 路由混在一个大文件里。

### 11.3 SidePanel 拆分

当前 `App.vue` 更像工程总控台。目标是把产品面和平台控制面拆开。

目标分层：

1. `AppShell.vue`
   - 只负责 panel shell、主导航、overlay 管理
2. `ChatWorkspaceView.vue`
   - 聊天主链路、会话、分叉、输入框、工具历史
3. `EnvironmentView.vue`
   - Bridge、runtime strategy、工作目录、系统 prompt
4. `ModelsView.vue`
   - provider route / llm profiles
5. `SkillsLibraryView.vue`
   - 启用、安装、discover、显式运行
6. `ExtensionsView.vue`
   - 插件启停、安装、基础检查
7. `DiagnosticsView.vue`
   - debug、inspect、trace
8. `PluginStudioView.vue` / 未来 `SkillStudioView.vue`
   - 明确作为开发者面，不再和用户运行面混在一起

### 11.4 Store 拆分

`runtime.ts` 不应继续同时管理：

- chat
- session
- config
- skill
- plugin
- health
- edit-rerun

目标拆分：

1. `conversation.store.ts`
2. `session.store.ts`
3. `config.store.ts`
4. `skills.store.ts`
5. `plugins.store.ts`
6. `diagnostics.store.ts`

共享层只保留轻量 `runtime-client.ts`，负责 `chrome.runtime.sendMessage`。

## 12. 产品层定义修正

### 12.1 默认产品面

默认用户应该看到的是：

1. 聊天
2. 会话
3. 模型路由
4. 环境配置

### 12.2 稳定能力面

当 skills / plugins 产品化后，再作为稳定入口暴露：

1. Skills Library
2. Extensions

这里不应该默认暴露底层实现词汇：

- `mem://`
- `lifo`
- `plugin.json`
- `registry`
- `热更新`

这些属于开发者语义，不是普通产品语义。

### 12.3 开发者面

Plugin Studio、未来 Skill Studio、深度 Debug 都应进入开发者面。

原则是：

1. 使用技能/扩展 和 开发技能/扩展 分离
2. 运行态产品面 和 平台控制面 分离

## 13. BDD / Contract 体系修正

当前 BDD 最大的问题不是“没有文件”，而是：

1. 分类维度过粗
2. 文档与契约口径有漂移
3. required proof 允许用源码锚点充数

目标改法：

### 13.1 分离 layer 与 domain

当前 `ux | protocol | storage` 只能表达“哪一层”，表达不了“哪个产品模块”。

应拆成两个维度：

1. `layer`
   - `business`
   - `technical`
   - `storage`
2. `domain`
   - `chat`
   - `context_ref`
   - `filesystem`
   - `skill`
   - `plugin`
   - `provider`
   - `automation`
   - `panel`
   - `session`

### 13.2 必需 proof 必须可执行

required proof 只允许：

1. unit
2. integration
3. browser-cdp
4. e2e

源码锚点可以保留，但只能作为补充说明，不能单独满足 required layer。

### 13.3 为新设计补契约

至少新增：

1. `BHV-CONTEXT-REF-PARSE`
2. `BHV-CONTEXT-REF-RESOLVE-HOST-BROWSER`
3. `BHV-CONTEXT-REF-MATERIALIZE-BUDGET`
4. `BHV-CONTEXT-REF-SYSTEM-PROMPT-INCLUDE`
5. `BHV-PANEL-MENTION-FILE-PROVIDER`
6. `BHV-SKILL-CATALOG-BODY-SEPARATION`
7. `BHV-RUNTIME-ROUTER-DISPATCH-BOUNDARY`

## 14. v1 实施范围

### 14.1 必做

1. `SessionWorkingContext` 入 session schema
2. host metadata primitive：`stat` / `list`
3. `execute_skill_script` 改为 browser-native skill script 执行
4. 输入框支持 `@路径`
5. 增加 `contextRefs` 结构化载荷
6. 落 `ContextRefService`
7. system prompt 支持 `@路径`
8. `runtime-loop` 至少先拆出 prompt policy 和 context ref
9. `runtime-router` 至少先拆出 run/session/skill/plugin controller

### 14.2 可延后

1. 目录 attach 的高级交互
2. Skill Studio
3. Plugin Studio 与 PluginsView 的产品化关系重整
4. 更复杂的上下文缓存策略

## 15. 分阶段计划

### Phase 0: 边界脚手架

进入条件：以下清单全部完成，才能进入 Phase 1。

1. 引入 `SessionWorkingContext`，禁止新逻辑继续依赖泛化 `cwd`。
2. 为 host filesystem 增加内核私用 `stat` / `list` primitive。
3. 定义统一的 `FilesystemInspectService`：
   - host 走 bridge-private metadata primitive
   - browser 走 VFS metadata/list provider
4. 建 `context-ref/`、`prompt/`、`runtime-router/` 目录。
5. 保留外部 facade，不先改对外协议。
6. 把现有 system prompt / skill prompt 组装逻辑迁出 `runtime-loop.browser.ts`。
7. 把 `buildLlmMessagesFromContext()` 变成 async，给 context resolve/materialize 留正式入口。
8. 把 `execute_skill_script` 的目标态改成 browser-native，不再要求迁移到 host path。

### Phase 1: Composer `@路径`

1. 把 `ChatInput.vue` 的 `@` 逻辑改为 mention provider gateway。
2. 首先接入 file provider 和现有 tab provider。
3. v1 只允许普通聊天输入使用 `/mem/...` 作为 browser sandbox 路径语法。
4. `sendPrompt()` 增加 `contextRefs`。
5. `brain.run.start` / `brain.run.steer` / `brain.run.follow_up` 增加 `contextRefs` 协议字段。
6. 对 `@./...` / `@../...` 缺少 `hostCwd` 的情况返回显式错误，而不是静默猜测。

### Phase 2: Runtime ContextRef Pipeline

1. resolve host/browser path
2. materialize with budget
3. build context index
4. 把 context refs 接到 LLM message assembly
5. `@/mem/...` 和 skill `location` 走同一条 browser resolver

### Phase 3: System Prompt / Skills 接入

1. `llmSystemPromptCustom` 支持 `@路径`
2. skills references 复用 resolver
3. `/mem` 显示语义在 UI 中统一化
4. `execute_skill_script` 与 skill resource resolver 共用定位层

### Phase 4: Router / Panel 收口

1. controller 拆分
2. store 拆分
3. App shell 收口
4. developer surface 与 default product surface 分离

### Phase 5: BDD 收口

1. 修正 contract category 模型
2. 补 context_ref 相关契约
3. 取消“源码锚点可替代 required proof”的门禁口径

## 16. 拒绝方案

### 16.1 方案 A：直接把 `@mem://...` 做成 prompt 替换

拒绝原因：

1. 这只是模板 include，不是文件上下文系统。
2. 无法控制预算。
3. 无法支持目录/二进制/大文件策略。
4. 最后一定会继续把逻辑堆进 `runtime-loop`。

### 16.2 方案 B：只改输入框，不改 runtime

拒绝原因：

1. 输入框会变成“伪 attachment”。
2. 运行时没有结构化引用模型，最终还是字符串拼接。
3. system prompt / skills / references 仍然各走各的。

### 16.3 方案 C：继续维持现有超级节点，先把功能做出来

拒绝原因：

1. 这正是当前架构开始漂移的根因。
2. 新功能每多一个，后续重构成本就更高。

## 17. 最终判断

正确方向不是“做一个 prompt include 小语法”，而是：

1. 把 browser sandbox 与 host filesystem 统一成 Linux-like 文件上下文模型。
2. 用 `@路径` 作为显式用户入口。
3. 用 `ContextRef` 作为运行时结构化载体。
4. 用 resolve/materialize/index 的懒加载流程控制 prompt 预算。
5. 借这个机会把 `runtime-loop`、`runtime-router`、SidePanel 从超级节点拉回到清晰边界。

这样做的结果是：

1. `@路径` 会成为系统底层能力，而不是聊天输入框技巧。
2. skills / system prompt / references / future context injection 都会落在同一套机制上。
3. 后续再做文件选择器、目录 attach、saved prompts、workspace memory，都不需要重新发明一套语法和管线。
