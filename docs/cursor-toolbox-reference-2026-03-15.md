# Cursor-Toolbox 参考记录（2026-03-15）

外部参考仓库：`/Users/envvar/P/Cursor-Toolbox`

用途：作为 `cursor_help_web` / 帮助页 page-hook 链路的重要外部参考，尤其是：

- 帮助页内多对话归档
- `sessionKey` / `conversationKey` 设计
- SSE continuation 聚合
- page hook 对 `/api/chat` 的请求改写与流式截断

## 1. 关键结论

`Cursor-Toolbox` 解决“帮助页里多个对话”的核心方式不是简单多开窗口，而是：

1. 在 page hook 中为 API 请求推导稳定的 `sessionKey`
2. 在 content 层把 `sessionKey` 归一成 `conversationKey`
3. 用 `conversationKey` 做会话 upsert / continuation merge / 工具调用续跑归档

这意味着：

- 同一个帮助页可以承载多个逻辑会话
- 真正的隔离键是 `sessionKey/conversationKey`
- 窗口 / tab 只是载体，不是唯一会话边界

## 2. 关键代码锚点

### 2.1 page hook：请求级会话键

文件：`/Users/envvar/P/Cursor-Toolbox/src/injected/page-hook.js`

关键实现：

- `deriveSessionKey(requestUrl, bodyData)`
  - 优先用 `body.id`
  - 再用 `body.conversationId`
  - 再用路由 `/chat/:id`
  - 最后退化到 `requestUrl + messages seed` hash

相关位置：

- `src/injected/page-hook.js:422`
- `src/injected/page-hook.js:433`
- `src/injected/page-hook.js:1304`

### 2.2 page hook：continuation 聚合

文件：`/Users/envvar/P/Cursor-Toolbox/src/injected/page-hook.js`

关键实现：

- `getContinuationAggregate(sessionKey)`
- `setContinuationAggregate(sessionKey, text)`
- `clearContinuationAggregate(sessionKey)`
- `rewriteToolEventsInSseResponse(response, requestUrl, sessionKey, options)`

它会按 `sessionKey` 维护最近 continuation 文本，把被截断的 SSE 输出继续拼回同一逻辑会话。

相关位置：

- `src/injected/page-hook.js:374`
- `src/injected/page-hook.js:381`
- `src/injected/page-hook.js:400`
- `src/injected/page-hook.js:967`

### 2.3 content shell：会话归档与多对话视图

文件：`/Users/envvar/P/Cursor-Toolbox/src/content/content-session-shell.js`

关键实现：

- `upsertSession(snapshot, { mergeEntries })`
- `upsertSessionFromApiRequest(payload)`
- `finalizeSessionFromApiStream(payload)`
- `conversationKey` 挂到 session state 上
- `pendingApiSessions[conversationKey] = target.id`

这说明它在 content UI 层已经把 API 会话视作“多对话模型”，而不是“当前页面只有一个对话”。

相关位置：

- `src/content/content-session-shell.js:2535`
- `src/content/content-session-shell.js:2576`
- `src/content/content-session-shell.js:2604`
- `src/content/content-session-shell.js:2718`

## 3. 对本仓库的启发

对 `browser-brain-loop` 来说，`Cursor-Toolbox` 证明了两件事：

1. `Cursor Help` 页内多对话不是伪需求，确实可以用 `sessionKey/conversationKey` 做稳定建模
2. 如果要减少多窗口/多标签页带来的用户感知，不能只做“tab 池”，还要把：
   - 请求键
   - continuation 聚合
   - conversation 归档
   - 工具调用续跑
   放到统一模型里

## 4. 当前使用建议

后续只要涉及以下主题，优先回看本参考：

- `cursor_help_web` 的多槽位 / 多会话设计
- 帮助页 page hook 的 prompt rewrite
- 工具调用后 continuation 拼接
- `sessionKey` / `conversationKey` 的边界定义

## 5. 注意

这个参考仓库是“实现参考”，不是产品边界的最终权威。

在本项目里落地时，仍然需要遵守本仓库约束：

- 大脑永远在浏览器侧
- 本地 bridge 不做任务决策
- 注入脚本最终产物必须单文件自包含
