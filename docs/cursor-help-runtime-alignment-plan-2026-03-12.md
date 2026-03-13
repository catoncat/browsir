# Cursor Help Runtime Alignment Plan

## 背景

真实页面调试已经证明两件事：

1. `cursor.com/help` 的请求链路已经被我们接管，`/api/chat` 请求里能看到注入的 `system` prompt。
2. 即便请求里已有 `system` prompt，最终回复仍可能保持 Cursor Help 自身人格。

同时还发现一个更基础的问题：

- 仓库当前源码和真实页面正在运行的注入脚本版本不一致。
- 本地源码已具备 `system + user-prefix` 双写逻辑，但现场抓到的请求只包含 `system` 注入。

在这个前提下，任何后续结论都必须先建立在“运行时版本已对齐、调试信息可见”的基础上。

## 目标

第一阶段只解决观测与对齐，不先改最终产品行为：

- 能明确知道当前页面跑的是哪一版 page hook / content script。
- 能明确知道一次 `/api/chat` 请求到底用了什么改写策略。
- 能在 SW 侧识别“页面运行时版本落后于当前扩展版本”，并阻止误判。

## 实施步骤

1. 保存并统一 `cursor-help` 运行时版本标识。
   - 增加共享版本常量与改写策略常量。
   - page hook、content script、SW 共用同一份元信息。

2. 给 page hook 增加结构化改写诊断。
   - 记录运行时版本、改写策略、命中的目标消息索引与类型。
   - 记录是否插入 `system`、是否插入 `user-prefix`。
   - 只记录 hash、长度、索引等摘要，不打印完整 prompt。

3. 把运行时元信息透传到 inspect 与 transport 事件。
   - `webchat.inspect` 返回 page/content runtime version、rewrite strategy、mismatch 状态。
   - `request_started` transport 事件携带 rewrite debug 摘要。

4. 在 SW 侧把版本不一致视为不可执行状态。
   - 先阻止旧 runtime 静默参与执行。
   - 报出明确错误，让后续活体实验建立在同一版 bundle 上。

5. 补测试。
   - 协议层测试覆盖 rewrite debug 输出。
   - SW 测试覆盖 runtime version 对齐与 mismatch 拒绝。

## 第一阶段完成标准

- 可以从 inspect 结果直接判断：
  - 当前页面 page hook 版本
  - 当前 content script 版本
  - 当前改写策略
  - 是否存在 runtime mismatch
- 可以从 transport 日志直接判断：
  - 本次请求是否写入 `system`
  - 本次请求是否写入 `user-prefix`
  - 命中的目标消息位置

## 第二阶段决策门

等第一阶段落完，再做活体实验：

- `system only`
- `user-prefix only`
- `system + user-prefix`

只有实验结果稳定后，才决定是否继续保留 `cursor.com/help` 这条 provider 链路，以及是否收紧 role / model 设计。
