# WeChat Channel Runtime Design

日期：2026-03-22

## 结论

微信接入按 `weixin-bot` 的协议本体来做，不按 `weixin-agent-sdk` 的 Node 宿主桥接模型来搬。

目标形态不是“把微信做成一个外置 Node bot”，而是做成 Browser Brain Loop 内部的 `wechat channel runtime`：

- 浏览器内大脑仍然只在 extension Service Worker
- 微信协议收发放到扩展内的 offscreen daemon
- SidePanel 只负责登录、状态、绑定和调试

第一阶段只做 `text-only V0`：

1. 二维码登录
2. 长轮询收文本
3. `context_token` 缓存
4. 微信入站文本桥接到现有 session / run
5. 回复纯文本
6. 可选 `sendTyping`

## 已锁定决策账本

- 实现路线仍然是 `Approach B / First-Class Channel Kernel`，不是回退成 WeChat 专用 wedge。
- 这轮扩大的是 scope review 的 `A / SCOPE EXPANSION`，也就是把后面必然返工的 kernel 边界现在就拉正。
- 浏览器里永远只有一个 brain；微信只是第一个 remote invocation surface。
- `channel-store` 是 channel 侧主存储；session metadata 只保留轻量镜像。
- `ChannelTurn` 是标准远端 turn 对象，负责串起 inbound -> run -> projection -> delivery，但不自带第二套 scheduler。
- 现有 session `followUp` queue 仍是唯一 authoritative run queue。
- `channelTurnId` 要从入站确认一路贯穿到 run、assistant result、projection、delivery。
- assistant 可见结果要先经过统一结果出口，再做 channel projection，不能靠“读 branch 最后一个 assistant”来偷渡。
- reply projection 明确分两段：
  - `channel-runtime` 先产出统一 `ProjectionOutcome`
  - WeChat adapter 再做裁剪、分片、`context_token` 续接和发送
- offscreen host 自驱长轮询生命周期；SW 不负责 clock polling loop。
- channel handoff 直接复用现有 intervention 系统，不新造第二套审批流。

## 上层原则

这次接入不是“加一个微信 bot 功能”，而是借微信这个首个 transport，把 BBL 的 `channel runtime` 边界定义清楚。

先定 4 条原则：

### 1. `channel` 是一等内核概念，不是 WeChat 特性

WeChat 只是第一个 transport adapter，不应该拥有独立 runtime，也不应该把自身协议细节反向污染 kernel 的核心语义。

换句话说：

- kernel 里应该长出 `channel` 边界
- 不应该长出 `wechat-specific brain`

### 2. channel 负责 transport，不负责 agent 决策

channel 层应该只负责：

- transport 收发
- 远端身份
- conversation/session continuity
- reply projection

channel 不应该复制：

- planner
- loop controller
- tool 调度
- session 推理策略

这些仍然只属于现有 browser-side brain。

### 3. 对外回复必须经过 `reply projection`

内部 assistant transcript 不等于外部 channel 回复。

必须显式经过一层 projection，把内部运行产物投影成 channel 适合消费的输出，至少做：

- 只抽取用户可见结果
- 过滤调试痕迹、tool trace、系统提示
- 按 channel 能力约束做文本裁剪 / 分片
- 未来为图片/文件/卡片等能力留扩展位

也就是说，V0 发回微信的不是“会话原文”，而是“会话结果的 channel 化表达”。

这里再锁一层边界：

- 第一段由 `channel-runtime` 负责，把 run 的终态结果变成统一 `ProjectionOutcome`
- 第二段由 WeChat adapter 负责，把 `ProjectionOutcome` 变成微信可发送文本、分片与 `context_token` 驱动的发送动作

kernel 负责“结果是什么意思”，adapter 负责“在这个 channel 里怎么表达”。

### 4. 第二个 channel 的加入应表现为新 adapter，不是新系统

这个设计是否合理，可以用一个简单标准自检：

如果未来要接 Telegram / Email / Slack，主要新增的应当是：

- transport adapter
- identity mapping
- reply projection 规则

而不是再造一套：

- bot runtime
- session engine
- 决策循环

如果第二个 channel 还需要复制大块 runtime，那说明当前边界切错了。

## 为什么参考 `weixin-bot`

`weixin-bot` 更接近协议本体，核心就是：

1. `fetchQrCode` / `pollQrStatus`
2. `getUpdates`
3. `sendMessage`
4. `getConfig` / `sendTyping`
5. `context_token` / cursor 管理

这套模型天然像 channel transport，适合移植到扩展运行时。

`weixin-agent-sdk` 已经把问题包进了 Node 宿主假设，混入了：

- `fs/path/stream`
- 本地文件路径
- 媒体落盘
- `child_process`
- ACP 子进程

这些都不是浏览器插件的自然边界，V0 不应带入。

## 硬约束

### 1. 不能把长轮询主循环放进 extension Service Worker

Chrome 官方文档明确说明：

- Service Worker 30 秒空闲会被终止
- `fetch()` 响应超过 30 秒才到也会被终止

参考：

- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers

所以微信的 `getupdates` 长轮询不能直接跑在 `extension/src/background/sw-main.ts` 对应的 SW 里。

### 2. 本项目已经在使用 offscreen document，不能再天真地新开第二个

Chrome 官方说明每个 extension / profile 同时只支持一个 offscreen document。

本项目当前已经用 `sandbox-host.html` 作为 offscreen relay：

- `extension/src/sw/kernel/eval-bridge.ts`
- `extension/src/sandbox-host/main.ts`

因此微信 daemon 的正确做法不是“再建一个 `wechat-offscreen.html`”，而是把现有 `sandbox-host` 升级成**通用 offscreen host**，让它同时承载：

- sandbox relay
- wechat daemon

### 3. 媒体协议依赖 AES-128-ECB，不进 V0

微信媒体协议需要 AES-128-ECB；Web Crypto `SubtleCrypto.encrypt()` 支持的 AES 模式是 CTR / CBC / GCM，不包含 ECB。

参考：

- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt

所以媒体下载/上传不能靠浏览器原生 `crypto.subtle` 直接完成。V0 不做媒体链路，避免把实现复杂度和风险一次性引进来。

## V0 目标态架构

```text
SidePanel UI
  -> brain.channel.wechat.*

Service Worker
  -> runtime-router/wechat-controller
  -> channel-store / channel-runtime
  -> wechat-session-binding
  -> wechat-state
  -> wechat-offscreen-bridge
  -> BrainOrchestrator / runtimeLoop

Offscreen Host (reuse sandbox-host.html)
  -> sandbox relay
  -> wechat daemon
      -> QR login
      -> getupdates long-poll
      -> sendmessage
      -> getconfig/sendtyping
```

职责切分：

### Offscreen Host

- 跑二维码登录轮询
- 跑 `getupdates` 长轮询
- 直连微信协议接口
- 维护 bot 凭据、cursor、context token
- 自己负责 polling / backoff / reconnect lifecycle
- 把入站消息投递给 SW
- 接收 SW 的文本回复与 typing 指令并发送

### Service Worker

- 维护 `userId -> sessionId` 绑定
- 把入站微信消息映射到 BBL session
- 驱动 `brain.run.start` / follow-up 语义
- 持有 `channel-store` / `ChannelTurn` / `trustContext` / delivery ledger
- 在统一 assistant result commit 后做 projection
- 把 adapter-ready 的结果交回 offscreen host
- 做去重、幂等和调试记录

### SidePanel

- 登录按钮与二维码展示
- 通道开关、状态、最近错误
- 用户会话绑定查看
- 基础调试视图

## 最小 channel 边界

不管 transport 是微信还是未来别的 channel，最小稳定边界都应该围绕 3 件事建模：

### 1. inbound envelope

统一描述“外部 channel 来了一条什么消息”，最少需要：

- channel kind
- remote conversation id
- remote user identity
- message id
- message type
- normalized payload
- transport metadata

### 2. conversation / session mapping

统一描述“这条外部消息要落到 BBL 的哪个 session 上”，至少要能回答：

- 一个 remote conversation 对应一个 session，还是一组 session
- 用户级 identity 与会话级 identity 如何分离
- 多轮连续性由谁保证

### 3. outbound projection

统一描述“BBL 内部结果如何变成外部 channel 可发送内容”，至少要能回答：

- 回复文本怎么抽取
- 失败文案怎么产品化
- 超长内容怎么切片
- 后续媒体能力怎么扩展

## 关键设计决定

### A. 复用现有 `sandbox-host`，不新建第二个 offscreen 页面

第一步不是加新的 offscreen 入口，而是把：

- `extension/src/sandbox-host/main.ts`

从“只处理中继 sandbox 消息”，改成“通用 offscreen host 消息路由器”。

建议拆成：

- `extension/src/sandbox-host/main.ts`
- `extension/src/sandbox-host/sandbox-relay.ts`
- `extension/src/sandbox-host/wechat-daemon.ts`
- `extension/src/sandbox-host/wechat-api.ts`
- `extension/src/sandbox-host/wechat-storage.ts`

其中 `main.ts` 只做 dispatch：

- `sandbox-*` -> `sandbox-relay`
- `wechat.*` -> `wechat-daemon`

这样不破坏现有 sandbox 通路，也符合项目当前 offscreen 使用方式。

### B. `runtime-router` 只加一层薄控制器，不让它背协议细节

不要把微信协议和状态机直接堆进：

- `extension/src/sw/kernel/runtime-router.ts`

正确做法是新增 controller，再让 `runtime-router.ts` 只负责分发：

- `extension/src/sw/kernel/runtime-router/wechat-controller.ts`

新增路由前缀：

- `brain.channel.wechat.get_state`
- `brain.channel.wechat.login.start`
- `brain.channel.wechat.logout`
- `brain.channel.wechat.enable`
- `brain.channel.wechat.disable`
- `brain.channel.wechat.bind_session`
- `brain.channel.wechat.unbind_session`
- `brain.channel.wechat.debug`
- `brain.channel.wechat.inbound`

其中 `brain.channel.wechat.inbound` 只给 offscreen host 用，不给 UI 直接调用。

### C. 一个微信用户对应一个专用 session

V0 不做“多个渠道共用一个会话”的复杂路由。

存储关系：

- `wechatUserId -> sessionId`

session metadata 写明来源：

```json
{
  "channel": {
    "kind": "wechat",
    "wechatUserId": "xxx",
    "wechatBotUserId": "xxx"
  }
}
```

这样 `ChannelTurn -> assistant result commit -> projection -> 发回微信` 这条链路才是稳定的，不会误把 SidePanel 人工对话也发回微信。

### D. 入站消息统一走 session 追加，不做旁路 prompt

微信入站文本进入 SW 后，最终仍然走现有 `runtimeLoop.startFromPrompt()`。

规则：

- 会话未运行：直接 `startFromPrompt`
- 会话已运行：用 `streamingBehavior = "followUp"` 入队

这和当前 `runtime-loop.browser.ts` 的中断/排队语义一致，不需要重做第二套队列。

### E. cursor 按“SW 已确认接收”后再推进

不能像 `weixin-bot` 那样在拿到 `getupdates` 结果后立刻无脑推进 cursor。

否则 offscreen 拿到消息、但 SW 还没落地 session / 去重状态时，cursor 已推进，消息可能永久丢失。

V0 建议：

1. offscreen 长轮询拿到 `msgs + nextCursor`
2. 逐条把消息发给 SW 的 `brain.channel.wechat.inbound`
3. SW 返回 `accepted` / `duplicate`
4. 整批都确认后，offscreen 才持久化 `cursor = nextCursor`

配合 SW 侧 `message_id` 去重，语义变成“至少一次投递 + 幂等处理”。

### F. 先留出 trust boundary，不把本地敏感上下文默认暴露给 channel

像“帮我看看电脑里的最近对话/文件/标签页”这类请求，虽然最终仍由现有 brain 执行，但入口来自外部 channel，风险模型已经变了。

因此 channel 接入阶段就应预留 trust boundary，而不是等功能做大后再补：

- channel 来源要可识别
- session metadata 要能标注 channel 来源
- 后续如要放开敏感工具或本地上下文读取，应能基于 channel/source 做能力收敛

V0 可以先不做复杂权限系统，但设计上不能默认“微信消息 = SidePanel 本地消息”。

### G. `channel-store` 是 channel 主存储，不把 session metadata 挤成总账本

channel 相关的这些状态不应该散落在 session metadata 和 host 临时内存里：

- binding
- turn progression
- delivery ledger
- dedupe marker
- 最小 transport mirror

因此需要独立 `channel-store`：

- `session metadata` 只镜像 `channel.kind / remoteConversationId / trust tier` 这类最小信息
- `channel-store` 才是查询“这条远端消息现在走到哪一步”的 authoritative source

### H. `ChannelTurn` 负责表达远端 turn，不负责调度

`ChannelTurn` 的价值不是另造一个 runtime，而是给 remote turn 一个稳定身份：

- 入站创建 `channelTurnId`
- 运行时把 `channelTurnId` 带进 queued prompt / run / assistant result
- delivery ledger 也回指这个 `channelTurnId`

但它不拥有新的 scheduler：

- 会话未运行 -> `start`
- 会话运行中 -> `followUp`

这条队列仍然完全复用现有 runtime。

### I. assistant 结果先统一 commit，再做 projection

WeChat V0 虽然只回纯文本，但架构上不能继续依赖：

- `loop_done`
- 读 branch 最后一个 assistant
- 猜这是不是这条微信消息对应的结果

正确边界应该是统一的 assistant result commit：

- run 先产出 assistant-visible result
- `channel-runtime` 基于这个结果生成 `ProjectionOutcome`
- adapter 再发到微信

这样第二个 channel 才不会各自去 session branch 里“捞结果”。

### J. SW <-> offscreen 要走共享 `host protocol`

不要让 SW 和 offscreen 之间长满 feature-specific message type 碎片。

更稳的边界是共享 host protocol：

- 通用 envelope：command / response / event / correlation
- WeChat-specific payload 放到 adapter payload 里
- offscreen 可以异步上报 transport event
- SW 只发 control-plane intent，不负责 clock transport loop

### K. channel handoff 直接复用现有 intervention 系统

当 remote request 触发本地审批时：

- channel 层只负责把它投影成 `needs_intervention`
- 本地继续走现有 intervention state machine
- approval / cancel / timeout 再回投影成 channel 可见终态

不是“为微信做一个审批系统”，而是“让 channel 成为现有 intervention 系统的远端入口”。

## 建议新增模块

### SW 侧

- `extension/src/sw/kernel/runtime-router/wechat-controller.ts`
  - 处理 `brain.channel.wechat.*`
- `extension/src/sw/kernel/wechat-types.ts`
  - runtime 内部类型
- `extension/src/sw/kernel/wechat-state.ts`
  - 凭据摘要、开关、绑定、去重游标等持久化读写
- `extension/src/sw/kernel/wechat-session-binding.ts`
  - `wechatUserId <-> sessionId`
- `extension/src/sw/kernel/wechat-offscreen-bridge.ts`
  - `ensureOffscreenHost()` + request/response bridge
- `extension/src/sw/kernel/wechat-run-observer.ts`
  - 订阅统一 assistant result commit，触发 projection / delivery

### Offscreen Host 侧

- `extension/src/sandbox-host/wechat-daemon.ts`
  - 登录、轮询、回复、typing
- `extension/src/sandbox-host/wechat-api.ts`
  - 对应 `weixin-bot` 的 browser 化 API 封装
- `extension/src/sandbox-host/wechat-storage.ts`
  - offscreen 本地持久化
- `extension/src/sandbox-host/wechat-message-normalizer.ts`
  - 先只做 text-only 归一化

### Panel 侧

- `extension/src/panel/stores/wechat-store.ts`
- `extension/src/panel/components/WechatChannelCard.vue`

V0 不必新开大页面，先把入口放进 `SettingsView.vue` 即可。

## 共享 Host Protocol 建议

### SW -> Offscreen Host

```ts
type WechatHostRequest =
  | { type: "wechat.ensure" }
  | { type: "wechat.get_state" }
  | { type: "wechat.login.start"; force?: boolean }
  | { type: "wechat.logout" }
  | { type: "wechat.poll.enable"; enabled: boolean }
  | { type: "wechat.reply.text"; sessionId: string; userId: string; text: string }
  | { type: "wechat.typing"; userId: string; status: 1 | 2 };
```

### Offscreen Host -> SW

```ts
type WechatHostEvent =
  | { type: "brain.channel.wechat.inbound"; payload: WechatInboundEnvelope }
  | { type: "brain.channel.wechat.host_state"; payload: WechatRuntimeStateSnapshot }
  | { type: "brain.channel.wechat.host_error"; payload: { code: string; message: string } };
```

实现时应进一步收敛成共享 host envelope：

- 外层统一 `kind / correlationId / command|event / payload`
- WeChat-specific action 作为 payload 内部字段存在
- 不把 top-level message type 做成未来难以复用的协议碎片

### SW 内部持久化

```ts
interface WechatChannelState {
  enabled: boolean;
  login: {
    status: "logged_out" | "pending" | "logged_in" | "error";
    qrCode?: string;
    qrImageDataUrl?: string;
    botTokenPresent: boolean;
    baseUrl?: string;
    accountId?: string;
    botUserId?: string;
    lastError?: string;
    updatedAt: string;
  };
  cursor: string;
  bindings: Record<string, { sessionId: string; updatedAt: string }>;
  contextTokens: Record<string, { token: string; updatedAt: string }>;
  processedMessageIds: Record<string, string>;
}
```

说明：

- `bot_token` 建议只存 offscreen host / storage，不回传到 panel store
- SW 的 `login` 摘要只保留 presence / account info / error
- `processedMessageIds` 做有限 LRU，别无限长

## 核心时序

### 1. 登录

1. Panel 调 `brain.channel.wechat.login.start`
2. SW 通过 `wechat-offscreen-bridge` 把命令发给 offscreen host
3. offscreen 调 `fetchQrCode`，返回二维码
4. offscreen 自己轮询 `pollQrStatus`
5. 成功后把 credentials 存储并回报 `host_state`
6. SW 更新状态摘要，Panel 展示“已连接”

### 2. 入站文本

1. offscreen 调 `getupdates`
2. 收到 `msgs + nextCursor`
3. 过滤出 `message_type = USER`
4. text-only 归一化后向 SW 发 `brain.channel.wechat.inbound`
5. SW:
   - 做 `message_id` 去重
   - 创建 `ChannelTurn`
   - 更新 `context_token`
   - 解析 / 创建绑定 session
   - 如开启 typing，则让 offscreen 发 `status=1`
   - 调 `runtimeLoop.startFromPrompt`
6. SW 返回 `accepted` / `duplicate`
7. offscreen 全部确认后推进 cursor

### 3. 出站文本

1. SW 订阅统一 assistant result commit
2. run 先通过统一 assistant result commit 产出 assistant-visible result
3. `channel-runtime` 基于当前 `channelTurnId` 生成 `ProjectionOutcome`
4. WeChat adapter 将 `ProjectionOutcome` 转成待发送文本分片
5. 若该 `deliveryId` 尚未发出，则调 offscreen 发送
6. offscreen 用缓存的 `context_token` 调 `sendMessage`
7. 成功后 SW 更新 delivery ledger
8. offscreen 尝试 `sendTyping(status=2)`

## V0 文本抽取规则

只发“用户可见最终文本”，不发内部调试上下文。

推荐规则：

1. 从统一 assistant result commit 中读取当前 `channelTurnId` 对应的 assistant-visible result
2. `channel-runtime` 先生成统一 `ProjectionOutcome`
3. WeChat adapter 再根据微信能力约束做文本切片
4. 若无可用 assistant 文本：
   - 不回传内部异常
   - 发送简短产品化失败文案
5. 超长文本按微信限制切片发送

不要把诊断、tool trace、系统提示词、调试字段发到微信。

这层规则就是 `reply projection` 在 V0 的最小实现。

## 幂等与恢复

### 去重

- 主键：`message_id`
- 存储：SW `processedMessageIds`
- 语义：收到重复消息时直接 ack，不再次触发 run

### 恢复

- SW 重启后，从 `chrome.storage.local` 恢复绑定、去重表、状态摘要
- offscreen 重启后，从存储恢复 credentials / cursor / context token
- 若 token 过期，offscreen 进入 `logged_out`，要求重新扫码

### 错误退避

- 轮询失败指数退避：1s -> 2s -> 4s -> 8s，上限 10s
- `-14` 等 session 失效时直接清 credentials，转登录态

## 实现顺序

### Phase 1：先打通 runtime 骨架

先做这些：

1. 复用 `sandbox-host.html`，在 `main.ts` 增加 wechat message dispatch
2. 新增 `wechat-daemon.ts` + browser 化 `api.ts`
3. 新增 SW `wechat-offscreen-bridge.ts`
4. 新增 `runtime-router/wechat-controller.ts`
5. 先定义共享 host protocol envelope
6. 做 `brain.channel.wechat.get_state/login.start/logout`

这一阶段先不接 brain.run，只验证：

- 二维码登录
- 状态持久化
- offscreen <-> SW 双向消息

### Phase 2：接入文本收发

1. 增加 `brain.channel.wechat.inbound`
2. 增加 `wechat-session-binding.ts`
3. 增加 `channel-store` / `ChannelTurn`
4. 入站文本 -> `runtimeLoop.startFromPrompt`
5. assistant result commit -> `ProjectionOutcome` -> `sendMessage`
6. 加 `sendTyping`

到这里 V0 已经成立。

### Phase 3：补可靠性

1. `message_id` 去重
2. cursor after-ack
3. delivery ledger / dead-letter
4. trust boundary + intervention handoff
5. token 失效自动转登录态
6. 面板调试信息

## 测试建议

至少补这些测试：

1. 登录成功后 credentials 和状态摘要被正确持久化
2. 微信入站文本创建或复用专用 session
3. session 正在运行时第二条消息走 `followUp`
4. assistant result commit 后只发送一次对应 `channelTurnId` 的结果
5. 重复 `message_id` 不会二次触发
6. offscreen 重启后可恢复轮询状态
7. token 失效后状态切回登录态

建议新增：

- `extension/src/sw/kernel/__tests__/wechat-controller.browser.test.ts`
- `extension/src/sandbox-host/__tests__/wechat-daemon.test.ts`

如果后续补 BDD，先补 text-only 契约，不要先碰媒体。

## 不做的事

V0 明确不做：

- ACP / child_process
- 本地 filePath 模型
- 媒体下载
- 媒体解密
- 媒体上传
- 图片/文件回复
- 多 channel 抽象泛化过度

## 成功标准

这版设计完成后，应该满足：

1. 微信消息可以启动或继续一个现有 BBL session，而不是启动第二套 runtime
2. 多轮上下文连续，`remote conversation -> session` 映射稳定
3. channel transport 与 agent decision-making 明确分层
4. 发回微信的是经过 projection 的用户可见结果，不是内部 transcript 倾倒
5. 未来新增第二个 channel 时，主要工作看起来像新增 adapter，而不是复制一套 bot system

## 一句话决策

先把现有 `sandbox-host` 升级成**唯一 offscreen host**，在里面挂一个 `weixin-bot` 风格的 text-only daemon；SW 只做 session 绑定、run 驱动和最终回复抽取。不要先改大块 `runtime-router.ts`，也不要新开第二个 offscreen document。
