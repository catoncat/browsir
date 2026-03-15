---
id: ISSUE-022
title: "浏览器自动化效率对齐 AIPex — 快照压缩 / 验证简化 / 编排策略"
status: done
priority: p1
source: competitive-analysis
created: 2026-03-15
assignee: agent
resolved: 2026-03-15
kind: epic
depends_on: []
write_scope:
  - extension/src/sw/kernel/infra-snapshot-helpers.ts
  - extension/src/sw/kernel/snapshot-enricher.ts
  - extension/src/sw/kernel/runtime-loop.browser.ts
  - extension/src/sw/kernel/loop-browser-proof.ts
  - extension/src/sw/kernel/loop-failure-protocol.ts
  - extension/src/sw/kernel/loop-shared-types.ts
  - extension/src/sw/kernel/tool-contract-registry.ts
  - extension/src/sw/kernel/prompt/
tags:
  - epic
  - browser-automation
  - performance
  - competitive-alignment
---

## 背景

与 AIPex (~/work/repos/_research/AIPex/) 对比发现，BBL 浏览器自动化操作效率显著低于竞品。
核心症状：操作缓慢、多轮才完成简单任务、LLM 经常迷失方向。

## 根因分析

### RC-1: 快照 Token 爆炸

BBL `formatNodeCompact()` 不过滤无意义 ARIA 角色，所有节点都发给 LLM。
AIPex 过滤 13+ 角色 (`generic`, `none`, `group`, `main`, `navigation`, `contentinfo`, `search`,
`banner`, `complementary`, `region`, `article`, `section`, `InlineTextBox`, `presentation`, `LineBreak`)，
且 `search_elements` 只返回匹配行 + context —— 像 grep 而非 cat。

**影响**: Token 浪费、LLM 信噪比低、找不到目标元素。

### RC-2: 验证策略过重

BBL 每个 click/fill/press 都经历 pre-observe → 执行 → post-observe → diff 验证。
`browser_proof_guard` 强制 LLM 做验证步骤，否则 loop 终止。
AIPex **没有自动验证**，执行完直接返回，由 LLM 自主决定是否需要确认。

**影响**: 每个动作多 2+ CDP 调用 + 至少 1 个额外 LLM turn。

### RC-3: 失败信封过重

BBL 每次失败返回 `failureClass` + `resume` + `modeEscalation` + `retryHint` 等大量元数据。
AIPex 失败消息截断到 500 字符，只保留核心错误信息。

**影响**: LLM 被失败元数据淹没，无法聚焦核心问题。

### RC-4: 缺少集中编排策略

AIPex 在 `skill/SKILL.md` 定义三级优先级决策树：
1. 优先 `search_elements` (glob + OR 查询)
2. 用返回 UID 做 click/fill
3. 只在连续两次 search 失败后才 screenshot + computer

BBL 策略分散在各 tool description 里，LLM 没有统一决策树指导。

**影响**: LLM 可能跳过快速路径直接截图，浪费 token 和轮次。

## 深入对比：快照压缩

### 当前 BBL 快照管线（完整追踪）

1. **AX 树获取**: `takeInteractiveSnapshotByAX()` 从 CDP `Accessibility.getFullAXTree` 拿全树
2. **初筛**: 跳过 `ignored=true` + 无 `backendDOMNodeId` 的节点
3. **角色过滤**: `inferSearchElementsFilter(query)` 只在 query 含特定关键词（input/textarea/fill/type 等）时返回 `"interactive"`，**大部分 query 走 `filter="all"`，跳过 isInteractiveRole 检查**
4. **候选池**: 上限 `3 * maxNodes`（默认 360 个节点）
5. **DOM 解析**: 每个候选节点调 `DOM.resolveNode` + `Runtime.callFunctionOn` 取 DOM 属性（20+ 字段）
6. **enrichment**: HierarchyEnricher + IntentEnricher + SessionContextEnricher
7. **排序+截断**: 按 focused > visible > hasLabel 排序，截到 maxNodes（默认 120）
8. **search 打分**: `scoreSearchNode` needle 分词加权，取 top maxResults（默认 20）
9. **返回格式**: **完整 JSON 对象数组**，每个节点 ~50-80 token

### AIPex 快照管线（对比）

1. **AX 树获取**: 同样 CDP `Accessibility.getFullAXTree`
2. **UID 稳定**: 读取 `data-aipex-nodeid` 属性，已有 UID 复用，新节点用 nanoid
3. **文本格式化**: 树转缩进文本行，`SKIP_ROLES` 过滤 15 个噪声角色
4. **搜索**: glob + `|` OR 语法，全文匹配，只返回匹配行 + contextLevels 行上下文
5. **返回格式**: **纯文本**，每个节点 ~10 token

### Token 开销对比估算（典型页面 500 AX 节点）

| 步骤 | AIPex | BBL |
|---|---|---|
| 候选节点数 | ~500 → 格式化时过滤掉 ~60% | ~500 → filter=all 时全部通过 |
| 有效节点数 | ~200 行文本 | ~360 候选 → 120 maxNodes → 20 结果 |
| search 返回 | ~5-15 匹配行 + context = ~30-80 行文本 | 20 个完整 JSON 对象 |
| Token/节点 | ~10 | ~50-80 |
| 总 Token | **~300-800** | **~1000-1600** |
| 信噪比 | 高（只看到匹配的） | 低（20 个完整节点，很多字段无用） |

### 关键改进点

1. **添加 SKIP_ROLES**: 在 `buildCompactSnapshot`/`formatNodeCompact` 层过滤 `generic/none/group/main/navigation/contentinfo/search/banner/complementary/region/article/section/presentation` 角色节点
2. **search_elements 返回 compact 文本**: 不返回 JSON 对象数组，返回 `buildCompactSnapshot` 格式，仅含匹配节点及 context
3. **支持 `|` OR 查询**: 在 `scoreSearchNode` 或新增搜索层支持 pipe 分隔的 OR 语义
4. **减少无用字段**: 即使保留 JSON 格式，也应裁剪到 LLM 实际需要的字段（uid, ref, role, name, value, tag）

## 深入对比：编排策略

### 当前 BBL system prompt 策略（完整追踪）

策略位于 `prompt-policy.browser.ts`，分散在以下位置：

- **line 207**: `"For browser tasks, enforce: semantic search -> action -> browser_verify."` — 核心三阶段
- **line 209**: `"prefer uid/ref/backendNodeId from latest search_elements; selector cannot be the sole target."` — 目标优先级
- **line 210**: typing 优先级（editable targets only）
- **line 211**: `"include expect whenever success criteria is clear"` — 验证不是可选的
- **lines 392-412**: 动态 `STRATEGY HINT` 当 failureCount ≥ 2 时注入
- **E_REF_REQUIRED**: 硬性拦截无 UID 的 element 操作，强制先 search_elements
- **TOOL_ORDER**: `search_elements` 在 element interaction 组首位，`computer` 排在后面，`browser_verify` 排最后

### AIPex system prompt 策略（对比）

集中在 `skill/SKILL.md`，三级优先级：

```
Priority 1: search_elements — 永远先用，glob 查询
Priority 2: UID 工具 — click/fill/hover 用返回的 UID
Priority 3: screenshot + computer — 只在 search_elements 连续两次失败后使用
```

无 verify 步骤、无 failure tracking、无动态策略注入。

### 关键差异

| 维度 | AIPex | BBL |
|---|---|---|
| 决策树位置 | 集中在一段文本开头 | 分散在 15+ 条 guidelines |
| computer fallback 条件 | "连续 2 次 search 失败" 显式 | 动态 STRATEGY HINT (≥2 failures) |
| verify 阶段 | 无 | 强制第三步 |
| 阶段数 | 2 步 (search → action) | 3-4 步 (search → action → verify → 可能 retry) |
| prompt token 开销 | ~200 token | ~800+ token (guidelines 太多) |

### 改进点

1. **在 system prompt 头部加显式决策树**: 三级优先级，明确 computer fallback 条件
2. **收拢分散 guidelines**: 把 15+ 条 browser 相关规则合并到决策树和子节
3. **verify 改为可选**: 从 "enforce: search → action → verify" 改为 "search → action (→ verify if needed)"
4. **精简 prompt**: 减少 guidelines 文本量，降低 system prompt token 开销

## 深入对比：验证策略

### 当前 BBL 验证管线（完整追踪）

1. **shouldVerifyStep()**: `on_critical`（默认）对 click/type/fill/press/scroll/select/navigate/action 自动验证
2. **Pre-observe**: `cdp.observe` 抓 URL + title + textLength + nodeCount
3. **执行动作**
4. **Post-observe**: 再抓一次同样数据
5. **buildObserveProgressVerify()**: 判定 ok = `urlChanged || titleChanged || (textLengthChanged && nodeCountChanged)`
6. **browser_proof_guard**: LLM 做了任何 BROWSER_PROOF_REQUIRED 工具（25 个）但没提供 proof → loop 终止（NO_PROGRESS_CONTINUE_BUDGET=1）
7. **failureCount tracking**: 验证失败时 target uid 的 failureCount++ 并注入后续 snapshot
8. **失败信封**: `attachFailureProtocol` 附加 failureClass + resume + modeEscalation

### observe ok 条件问题

`urlChanged || titleChanged || (textLengthChanged && nodeCountChanged)` 这个条件对以下常见操作**误判为失败**：
- 展开/收起下拉菜单（URL/title 不变，textLength 可能不够，nodeCount 可能 <10）
- 填写表单字段（URL/title 不变，textLength 就变了几个字，nodeCount 不一定变 >10）
- 点击 tab 切换内容（URL/title 可能不变）
- 点击 modal 打开/关闭
- hover 触发 tooltip

### browser_proof_guard 问题

NO_PROGRESS 触发条件 `browser_proof_guard` budget=1 意味着：
- LLM 做了浏览器操作，给了最终答案但没调 verify → **第一次允许继续，第二次直接终止 loop**
- 这强制 LLM 每次操作后都必须调 verify，增加 1 个 LLM turn

### AIPex 对比

AIPex **完全没有自动验证**。动作执行完返回结果，LLM 自己决定是否截图/重新搜索确认。

### 改进点

1. **默认 verify policy 改为 `off`**: 去掉自动 pre/post observe（省 2 CDP 调用/动作）
2. **保留 explicit expect**: 当 LLM 主动传 `expect` 参数时仍做验证
3. **browser_proof_guard 降级**: 从终止 loop 改为注入 warning message 继续
4. **简化 observe ok**: 如果保留 observe，放松条件为 `任意一项变化 = ok`
5. **失败信封瘦身**: `attachFailureProtocol` 只输出 `{ errorCode, hint: "一句话" }`

## Slice 拆分（含实现细节）

### Slice A: 快照角色过滤 + search_elements 精简
- `infra-snapshot-helpers.ts`: 添加 `SKIP_ROLES` 常量 + `formatNodeCompact` 中检查跳过
- `dispatch-plan-executor.ts`: search_elements 结果从 JSON 对象数组改为 compact 文本 + 匹配行标记
- `loop-shared-utils.ts`: `scoreSearchNode` 或新增层支持 `|` OR 查询
- 文件: `infra-snapshot-helpers.ts`, `dispatch-plan-executor.ts`, `loop-shared-utils.ts`
- 预期效果: search_elements 返回 token 降 3-5x，LLM 信噪比显著提升

### Slice B: 验证策略简化
- `loop-browser-proof.ts`: `shouldVerifyStep` 默认策略从 `on_critical` 改为 `off`
- `runtime-loop.browser.ts`: `browser_proof_guard` 从 NO_PROGRESS 终止改为注入 warning 继续
- `loop-shared-types.ts`: 保留 `NO_PROGRESS_CONTINUE_BUDGET` 但将 `browser_proof_guard` 设为 Infinity 或移除
- 文件: `loop-browser-proof.ts`, `runtime-loop.browser.ts`, `loop-shared-types.ts`
- 预期效果: 每个动作省 2 CDP 调用 + 0-1 个 LLM turn

### Slice C: 失败信封瘦身
- `loop-failure-protocol.ts`: `attachFailureProtocol` 输出精简为 `{ errorCode, hint }`
- 去掉 `failureClass`/`resume`/`modeEscalation` block
- 文件: `loop-failure-protocol.ts`
- 预期效果: 失败返回 token 降 5-10x

### Slice D: 集中编排策略
- `prompt-policy.browser.ts`: 在 system prompt 头部注入三级优先级决策树
- 收拢分散的 15+ 条 browser guidelines 到决策树节点下
- 文件: `prompt/prompt-policy.browser.ts`
- 预期效果: LLM 决策更快更准，减少不必要的截图路径

### Slice E: 截图 shaping (可选)
- `runtime-loop.browser.ts`: 在每次 LLM 调用前扫描历史 messages，剥离 base64 tool result，注入 transient user image
- 文件: `runtime-loop.browser.ts`
- 预期效果: 防止历史 context 被 base64 快速耗尽

### Slice 依赖关系
- A/B/C/D 互不依赖，可并行推进
- E 独立，优先级较低

## 竞品参考

- AIPex 仓库: `~/work/repos/_research/AIPex/`
- 快照管线: `packages/browser-runtime/src/automation/snapshot-manager.ts`, `packages/dom-snapshot/src/query.ts`
- 工具实现: `packages/browser-runtime/src/tools/`
- Agent loop: `packages/core/src/agent/aipex.ts`
- 编排策略: `skill/SKILL.md`, `skill/references/tools-reference.md`
- 截图 shaping: `packages/core/src/utils/screenshot-shaping.ts`
