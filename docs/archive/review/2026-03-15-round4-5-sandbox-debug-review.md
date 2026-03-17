# Round 4+5 Review: Sandbox 路径规范化 + CDP Debug 工具

**日期**: 2026-03-15
**审查范围**: virtual-path-resolver.ts (+240 NEW), lifo-adapter.ts (-180), plugin-runtime.ts (修改), cdp-debug.ts (+719 NEW)
**涉及 Agent**: Agent 3 (Sandbox), Agent 4 (Debug/Tool)

---

## Part A: Sandbox 路径规范化 (Round 4)

### HIGH（1 项）

#### H1: resolveVirtualPath 路径遍历防御缺口
**文件**: virtual-path-resolver.ts `resolveVirtualPath()`
**问题**: `resolveVirtualPath` 在 namespace 分发前未对完整路径调用 `normalizeRelativePath`。依赖各分支内部规范化，但某些分支（如直接返回 `mem://` 前缀拼接）可能遗漏。攻击者可构造 `mem://../../../etc/passwd` 绕过。
**修复**: 在函数入口处添加早期断言：`assert(!resolvedPath.includes('..'))` 或在 dispatch 前统一调用 `normalizeRelativePath`。

### MEDIUM（1 项）

#### M1: toNamespaceStorageKey 是恒等函数
**文件**: virtual-path-resolver.ts
**问题**: `toNamespaceStorageKey(key) { return key }` 无任何转换，增加间接层无意义。
**修复**: 若无未来扩展计划，内联使用。

### LOW（1 项）

#### L1: 函数名下划线前缀不统一
**修复**: 统一命名约定。

### INFO（1 项）

#### I1: 纯函数缺少单元测试
**修复**: 为 `resolveVirtualPath` 和 `normalizeRelativePath` 添加 edge-case 测试。

---

## Part B: CDP Debug 工具 (Round 5)

### HIGH（1 项）

#### H1: serve 模式无鉴权
**文件**: cdp-debug.ts serve command handler
**问题**: `serve` 子命令在 localhost:9229 暴露 `/eval` 和 `/sw-eval` 端点，任何本地进程可执行任意 JS。在共享开发机器上构成严重安全风险。
**修复**: 添加 token 鉴权（参考 `BRIDGE_TOKEN` 模式），`Authorization: Bearer <token>` 或查询参数。

### MEDIUM（4 项）

#### M1: DevToolsActivePort 文件内容未校验
**问题**: 直接 `parseInt(lines[0])` 未验证是否为合法端口号。
**修复**: 校验 1-65535 范围。

#### M2: BrowserSession 通过 any 强转访问 CdpClient 内部
**问题**: `(client as any)._ws` 访问私有属性，上游更新会静默破坏。
**修复**: 向 CdpClient 暴露公共 `isConnected()` 方法。

#### M3: PersistentCdpPool sessions 永不过期
**问题**: `Map<tabId, BrowserSession>` 只进不出，长时间运行会泄漏 WebSocket 连接。
**修复**: 添加 TTL 或 LRU 淘汰策略。

#### M4: getSession 无并发保护
**问题**: 两个并发请求可能对同一 tabId 创建两个 session。
**修复**: 用 Promise 锁或 `Map<tabId, Promise<BrowserSession>>` 去重。

### LOW（3 项）

#### L1: 无 SIGINT 清理
**修复**: 注册 `process.on('SIGINT', cleanup)` 关闭所有 WebSocket。

#### L2: discoverChrome 冗余调用
**修复**: 缓存 Chrome 路径。

#### L3: 无请求超时
**修复**: 为 CDP 命令添加合理超时（如 30s）。

---

## 额外发现

### lifo-adapter.ts 提取确认
状态干净，无死代码残留。

### plugin-runtime.ts replaceProvider 权限默认值不对称
**问题**: `mode=true`，`capability=false` — 可能不是设计意图。
**修复**: 确认并文档化，或对齐默认值。
