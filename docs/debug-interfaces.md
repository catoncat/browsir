# Debug Interfaces

给外部 AI 和工程调试用的“窄接口”约定。目标不是替代整包 diagnostics，而是先按模块拿小快照。

## 设计原则

- 先拿模块快照，再决定是否下载完整 diagnostics
- 单个接口只回答一个模块
- 返回结构稳定、紧凑、适合 `jq`
- 不把整段 step stream 默认塞进去

## Runtime Message 接口

通过扩展 runtime message 调用：

- `brain.debug.snapshot`

## Bridge HTTP 导出接口

给外部 AI / Codex 直接下载文件用：

- `GET /api/debug-snapshots?token=<BRIDGE_TOKEN>`
- `POST /api/debug-snapshots?token=<BRIDGE_TOKEN>`
- `GET /api/debug-snapshots/<id>?token=<BRIDGE_TOKEN>`

推荐做法：

1. 由扩展侧先调用 `brain.debug.snapshot`
2. 再把返回结果发布到 Bridge `debug-snapshots`
3. 外部 AI 只消费下载链接，不需要读对话上下文

请求字段：

- `scope`
  - `runtime`
  - `sandbox`
  - `plugins`
  - `skills`
  - `all`
- `sessionId`
  - 可选；`runtime` 和 `sandbox` 推荐带上

返回：

- `schemaVersion: "bbl.debug.snapshot.v1"`
- `generatedAt`
- `scope`
- `sessionId`
- `data`

## 各 scope 语义

### `runtime`

看 Agent 主循环与 kernel 内部状态：

- session 列表
- 每个 session 的 `RuntimeView`
- kernel 内部缓存与阻塞计数：
  - `liveRunStateSessionIds`
  - `cachedStepStreamSessionIds`
  - `pendingTraceWriteSessionIds`
  - `blockedTraceSessionIds`
- 若带 `sessionId`：
  - `stepStreamCount`
  - `lastEvent`

### `sandbox`

看浏览器侧 LIFO sandbox 运行状态：

- `flushCount`
- `flushSkippedCount`
- `forcedFlushCount`
- `commandCount`
- `commandTimeoutCount`
- `lastFlushReason`
- `lastCommand`
- `recent` trace tail

### `plugins`

看 plugin runtime 健康度与覆盖面：

- 启用/禁用/报错/timeout 计数
- 每个 plugin 的 usage/error/timeout/hook 调用数
- mode provider
- capability provider
- capability policy
- tool contract
- llm provider

### `skills`

看 skill registry 状态：

- 总数
- enabled / disabled 数
- `disableModelInvocation` 数
- 全量 skill metadata
- `resolver.summary`
- `resolver.bySkill`
  - 看最近哪些 skill resolve 失败
  - 看最后一次失败原因和 capability/session 关联

### `all`

一次返回上述四块。只建议在需要“平台总览”时使用。

## 推荐使用顺序

1. agent 卡住/无响应：先 `runtime`
2. browser sandbox / mem:// / bash 异常：先 `sandbox`
3. 插件接管/provider 覆盖/恢复异常：先 `plugins`
4. skill 安装/启用/提示词注入异常：先 `skills`
5. 仍不足以定位：再下载 `diagnostics-format.md` 对应的完整 diagnostics

## 与 Diagnostics 的关系

- `brain.debug.snapshot`：窄、快、模块化
- `diagnostics`：会话级整包证据，适合最终归因和归档

不要默认直接读取整个 diagnostics 文件。先小后大。
