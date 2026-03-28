# 微信 Channel 接入 — 技术架构报告

**日期：** 2026-03-28
**当前阶段：** V0 Text-Only（Phase 2 进行中）
**涉及模块：** 14 个源文件 + 6 个测试文件

---

## 一、设计定位

微信不是一个"附加的微信 bot 功能"，而是 BBL **Channel Runtime** 的第一个 transport adapter。核心原则：

1. **`channel` 是一等内核概念** — kernel 里长出 `channel` 边界，而非 `wechat-specific brain`
2. **channel 只负责 transport** — 不复制 planner / loop controller / tool 调度
3. **回复必须经过 reply projection** — 内部 transcript ≠ 外部 channel 回复
4. **第二个 channel 的加入应表现为新 adapter，不是新系统**

---

## 二、三层架构总览

```
┌──────────────────────────────────────────────────────────┐
│  SidePanel (Vue 3 + Pinia)                              │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ wechat-store.ts  │  │ SettingsView.vue             │  │
│  │ (Pinia store)    │  │ (QR / 状态 / 开关 / 断开)     │  │
│  └────────┬────────┘  └──────────────────────────────┘  │
│           │ chrome.runtime.sendMessage                   │
├───────────┼──────────────────────────────────────────────┤
│  Service Worker (Kernel)                                 │
│  ┌────────┴──────────────────────────────────────────┐  │
│  │ runtime-router.ts                                  │  │
│  │   └─ wechat-controller.ts (brain.channel.wechat.*) │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ channel-subsystem.ts → channel-store.ts (IndexedDB)│  │
│  │ channel-types.ts (Binding/Turn/Outbox/Event)       │  │
│  │ channel-observer.ts (loop_done → projection → send)│  │
│  │ channel-projection.ts (文本抽取 + 分片)             │  │
│  │ channel-broker.ts (SW ↔ Offscreen 桥接)            │  │
│  │ host-protocol.ts (通用 Host 信封)                   │  │
│  └────────┬──────────────────────────────────────────┘  │
│           │ chrome.runtime.sendMessage (host.command)    │
├───────────┼──────────────────────────────────────────────┤
│  Offscreen Host (sandbox-host.html，复用)                │
│  ┌────────┴──────────────────────────────────────────┐  │
│  │ main.ts (通用 dispatch: sandbox-* / host.command)  │  │
│  │ wechat-service.ts (WechatHostService 类)          │  │
│  │ wechat-api.ts (ilinkai 协议封装)                   │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 三、模块详解

### 3.1 Offscreen Host 层

#### `wechat-api.ts` — 微信协议封装

| API | 端点 | 用途 |
|-----|------|------|
| `fetchQrCode` | `GET /ilink/bot/get_bot_qrcode?bot_type=3` | 获取登录二维码 |
| `pollQrStatus` | `GET /ilink/bot/get_qrcode_status?qrcode=...` | 轮询扫码状态 |
| `getUpdates` | `POST /ilink/bot/getupdates` | 长轮询拉取新消息 |
| `sendTextMessage` | `POST /ilink/bot/sendmessage` | 发送文本回复 |

- 基础 URL：`https://ilinkai.weixin.qq.com`
- 认证：`Bearer <bot_token>` + `AuthorizationType: ilink_bot_token`
- 长轮询超时：40s（`AbortSignal.timeout`）
- `context_token` 驱动回复定位

#### `wechat-service.ts` — WechatHostService 类

**状态存储（localStorage）：**

| Key | 内容 |
|-----|------|
| `bbl.wechat.host.state.v1` | 运行状态快照 |
| `bbl.wechat.host.credentials.v1` | token / baseUrl / accountId / userId |
| `bbl.wechat.host.cursor.v1` | getupdates 游标 |
| `bbl.wechat.host.context-tokens.v1` | userId → context_token 映射 |
| `bbl.wechat.host.send-log.v1` | 最近 20 条发送日志 |

**核心能力：**

- **登录流：** `startLogin()` → `fetchQrCode` → `scheduleLoginPoll` (2s 间隔) → `pollLogin` → credentials 持久化
- **消息轮询：** `scheduleUpdatePoll` → `pollUpdates` → `getUpdates` → `deliverInboundBatch` → cursor after-ack
- **入站过滤：** `isInboundMessage()` 通过 botIds 判断消息方向，`toInboundMessage()` 只处理 `message_type === 1`（文本）
- **回复发送：** `sendReply()` 从 `contextTokens` 查 token，逐 part 调 `sendTextMessage`
- **错误恢复：** code `-14` 触发自动 logout + 状态清理；普通错误 2s 退避重试
- **持久恢复：** 构造函数调 `resumePersistedBackgroundWork()`，重启后自动恢复登录轮询或消息轮询

#### `main.ts` — 通用 Offscreen Host

复用 `sandbox-host.html`，通过消息类型 dispatch：
- `host.command` + `service === "wechat"` → `handleWechatHostCommand` → WechatHostService
- `sandbox-*` → iframe relay（原有沙箱中继）

---

### 3.2 Service Worker 层

#### `host-protocol.ts` — 通用 Host 协议信封

```typescript
HostCommandEnvelope  { type: "host.command", service, action, payload, id }
HostResponseEnvelope { type: "host.response", ok, data/error, id }
```

版本号：`bbl.host.v1`。设计上支持任意 `HostServiceId`（目前仅 `"wechat"`）。

#### `channel-broker.ts` — SW → Offscreen 桥接

- `ensureOffscreenHost()`：检查 offscreen contexts → 不存在则 `chrome.offscreen.createDocument`
- `sendHostCommand<TPayload, TData>()`：包装 envelope → `chrome.runtime.sendMessage` → 校验协议版本 → 返回 data

#### `channel-types.ts` — 核心领域类型

| 类型 | 主键 | 说明 |
|------|------|------|
| `ChannelBindingRecord` | `bindingKey` | 远端会话 → BBL session 映射 |
| `ChannelTurnRecord` | `channelTurnId` | 单条远端消息的完整生命周期 |
| `ChannelOutboxRecord` | `deliveryId` | 发送任务账本 |
| `ChannelEventRecord` | `eventId` | turn 级审计事件 |
| `ChannelProjectionOutcome` | — | 统一结果投影 |
| `ChannelReplyProjection` | — | 分片后的回复 |

**Turn 生命周期状态机：**

```
received → queued → running → projected → sending → delivered → closed
                                  ↓
                           safe_failure → closed
```

**Delivery 状态：** `not_requested → queued → sending → delivered / uncertain / dead_letter`

#### `channel-store.ts` — IndexedDB 持久层

4 个 object store：`channelBindings` / `channelTurns` / `channelEvents` / `channelOutbox`

索引：
- `channelBindings` → `by-session`（按 sessionId）
- `channelTurns` → `by-session` + `by-remote-message`（去重用）
- `channelEvents` → `by-turn`
- `channelOutbox` → `by-turn`

支持事务写入（`acceptInbound` 在一个 tx 里写 binding + turn + event）。

#### `wechat-controller.ts` — SW 路由控制器

处理 `brain.channel.wechat.*` 路由，7 个 action：

| Action | 说明 |
|--------|------|
| `get_state` | 透传到 offscreen 读状态 |
| `login.start` | 透传到 offscreen 启动登录 |
| `logout` | 透传到 offscreen 登出 |
| `enable` | 透传到 offscreen 启用通道 |
| `disable` | 透传到 offscreen 禁用通道 |
| `inbound` | **核心**：去重 → upsertBinding → createTurn → startFromPrompt / followUp |

**inbound 入站核心逻辑：**

1. `getTurnByRemoteMessage` 去重 → 已存在返回 `duplicate`
2. `upsertBinding` → 查现有绑定 / 创建新 session（metadata 带 channel 信息）
3. `readLatestAssistantEntryId` → 记录 baseline（后续 projection 对比用）
4. `acceptInbound` 事务写入 binding + turn + event
5. 判断当前 session 运行态：
   - **running** → `appendUserMessage` + `enqueueQueuedPrompt("followUp")` → turn 标记 `queued`
   - **idle** → `runtimeLoop.startFromPrompt()` → turn 标记 `running`

#### `channel-observer.ts` — 事件观察者

挂载到 `orchestrator.events.subscribe`，监听两类事件：

**`message.dequeued`（followUp 出队）：**
- 找到匹配 `queuedPromptId` 的 queued turn → 标记 `running`

**`loop_done`（运行完成）：**
- `findRunningTurn` → 找到当前 session 正在运行的 turn
- `resolveFreshAssistantResult` → 5 次重试（40ms 间隔），先查 entries 再查 stepStream
- 生成 `ProjectionOutcome` → `createWechatReplyProjection`（分片）→ `createOutboxRecord`
- 写 outbox + 更新 turn 状态
- 调 `sendHostCommand("wechat", "reply.text", ...)` 发送
- 成功 → `delivered`；失败 → `uncertain`

**文本抽取优先级：**
1. session entries 中最新 assistant（且非 baseline）
2. stepStream 中 `hosted_chat.turn_resolved` 的 `assistantText`（经过身份归一化）
3. stepStream 中 `step_finished` + `mode === "llm"` 的 preview
4. 全部失败 → safe_failure 文案

#### `channel-projection.ts` — 投影 + 分片

- `WECHAT_REPLY_PART_MAX_CHARS = 1000`
- `createProjectionOutcome` → 归一化文本 + truncated 标记
- `createWechatReplyProjection` → 按 maxChars 切片，每片 `{ kind: "text", text }`
- `createOutboxRecord` → 组装发送任务

#### `channel-subsystem.ts` — 子系统门面

简单封装，持有 `ChannelStore` 实例，挂在 `BrainOrchestrator.channels` 上。

---

### 3.3 Panel 层

#### `wechat-store.ts` — Pinia Store

**状态模型：** 镜像 `WechatHostStateSnapshot`（不含 credentials）

**操作：**
- `refresh()` / `startLogin()` / `logout()` / `enable()` / `disable()`
- `connect()` = enable + startLogin 组合
- `disconnect()` = logout + disable 组合

**轮询：**
- `pending` 状态 → 1.2s 刷新
- `logged_in` + `enabled` → 4s 刷新
- 其他状态停止轮询

**视图状态派生（`userView` computed）：** 5 种 UI 状态：`loading` / `idle` / `connecting_qr` / `connected` / `error`

---

## 四、核心数据流

### 4.1 登录流

```
Panel.connect()
  → brain.channel.wechat.enable
  → brain.channel.wechat.login.start
  → SW channel-broker → ensureOffscreenHost()
  → Offscreen wechat-service.startLogin()
  → fetchQrCode() → 返回 qrCode + qrImageUrl
  → 2s 定时器 pollLogin() → pollQrStatus()
  → confirmed → writeCredentials() → writeState(logged_in)
  → host_state 事件上报 SW
  → Panel 定时 refresh → userView = "connected"
```

### 4.2 消息入站

```
Offscreen pollUpdates()
  → getUpdates(cursor) [长轮询 40s]
  → deliverInboundBatch()
    → rememberContext() [缓存 context_token]
    → toInboundMessage() [过滤+归一化]
    → chrome.runtime.sendMessage(brain.channel.wechat.inbound)
  → SW wechat-controller.handleBrainChannelWechat()
    → 去重 getTurnByRemoteMessage()
    → upsertBinding() [创建/复用 session]
    → createTurn() [ChannelTurnRecord]
    → startFromPrompt() 或 enqueueQueuedPrompt("followUp")
  → Offscreen 确认 accepted → writeCursor(nextCursor)
```

### 4.3 回复出站

```
channel-observer 监听 loop_done
  → findRunningTurn()
  → resolveFreshAssistantResult() [5次重试]
  → createProjectionOutcome() [final_text / safe_failure]
  → createWechatReplyProjection() [1000字分片]
  → createOutboxRecord()
  → 写 IndexedDB (outbox + turn)
  → sendHostCommand("wechat", "reply.text")
  → Offscreen wechat-service.sendReply()
    → readContextTokens() → sendTextMessage()
  → 成功 → delivered / 失败 → uncertain
```

---

## 五、安全与可靠性机制

| 机制 | 实现 |
|------|------|
| **消息去重** | `remoteMessageKey` 索引，SW 侧幂等 |
| **Cursor after-ack** | 整批 SW 确认后才推进 cursor |
| **Trust boundary** | `trustTier: "external_remote"`，session metadata 标注来源 |
| **Token 失效** | API code `-14` → 自动 logout + 状态清理 |
| **Delivery ledger** | outbox record 追踪 deliveryStatus |
| **发送日志** | 最近 20 条 send log（localStorage） |
| **Offscreen 恢复** | 构造函数 `resumePersistedBackgroundWork()` |

---

## 六、V0 明确不做

- ACP / child_process / 本地文件路径
- 媒体下载/解密/上传（AES-128-ECB 不在 Web Crypto 支持范围）
- 图片/文件/卡片回复
- 工具调用 / 中间过程 / progress 投影到微信
- 多 channel 抽象泛化

---

## 七、模块依赖图

```
wechat-api.ts (纯协议)
    ↑
wechat-service.ts (Offscreen Host Service)
    ↑
main.ts (Offscreen dispatch)
    ↑ chrome.runtime.sendMessage
channel-broker.ts (SW → Offscreen 桥接)
    ↑
wechat-controller.ts ←── channel-types.ts
    ↑                      ↑
runtime-router.ts      channel-store.ts (IndexedDB)
    ↑                      ↑
orchestrator.browser.ts ← channel-subsystem.ts
    ↑
channel-observer.ts ←── channel-projection.ts
    ↑                      ↑
                        host-protocol.ts (共享信封)
```
