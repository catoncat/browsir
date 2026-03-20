# MV3 Sandbox Page 方案设计

> v2 — 整合审查报告修订

## 问题

Chrome MV3 的 CSP 严格禁止 `eval` / `new Function()`。LIFO sandbox (`@lifo-sh/core`) 的 `commands.run()` 内部使用 `new Function()` 加载 CJS 模块，导致以下功能在 Service Worker 中执行时报 `EvalError`：

| 受阻功能 | 调用路径 |
|---------|---------|
| Plugin Studio 在线安装 | `invokePluginSandboxRunner()` → LIFO `commands.run("node runner.cjs")` |
| `browser_bash` 工具 | `bashFrame()` → LIFO `commands.run(command)` |
| `execute_skill_script` (browser mode) | runtime-loop → `executeStep({ tool: "bash" })` → LIFO |

**不受影响的功能（纯 fs 操作，不触发 `new Function`）：**
- `browser_read_file` / `browser_write_file` / `browser_edit_file` — 走 `sandbox.fs.*` API
- Pre-built plugin loading — 走 `chrome.runtime.getURL()` + `import()`
- Sandbox 创建 / 销毁 / checkpoint — 内存数据结构操作

## 方案：Sandbox Page + 完整 LIFO Runtime

### 核心思路

MV3 允许在 manifest.json 中声明 `sandbox` 页面。Sandbox 页面有独立 CSP（允许 `eval`/`new Function()`），但**没有 chrome.\* API 访问权限**。

### 架构

```
Service Worker（CSP 禁止 eval）
    │
    │ fs 操作（read/write/edit/stat）
    │ → sandbox.fs.* 直接执行（留在 SW）
    │
    │ bash 操作（commands.run）
    ↓
EvalBridge（SW 侧）
    │ chrome.runtime.sendMessage
    ↓
SidePanel / Offscreen Document（中继宿主）
    │ postMessage
    ↓
eval-sandbox.html（iframe，CSP 允许 eval）
    │ 内嵌完整 @lifo-sh/core Sandbox 实例
    │ 接收 VFS 快照 → 初始化文件树
    │ 执行 commands.run()
    │ 返回 stdout/stderr + VFS diff
    ↓
结果原路返回
```

### 关键设计决策

#### D1: 在 sandbox page 中运行完整 LIFO Sandbox

不是简单的 `new Function(code)` wrapper。LIFO 的 CJS 加载器内部有完整的模块解析逻辑：
- 注入 `process`、`Buffer`、`console`、`setTimeout`、`require` 等 Node.js 兼容 API
- `require()` 解析依赖 `vfs.readFileString()` 读取 VFS 中的文件
- 模块缓存、循环引用处理

因此 sandbox page 必须：
1. 加载 `@lifo-sh/core`，创建真实的 `Sandbox.create()` 实例
2. 接收 VFS 文件快照，初始化 sandbox 的文件系统
3. 执行 `sandbox.commands.run(command)`
4. 返回 stdout/stderr + VFS 变更 diff

#### D2: VFS 快照同步（替代"按需传递"）

SW 发起 bash 命令前，将当前 session namespace 的文件树序列化：

```typescript
interface VfsSnapshot {
  files: Array<{ path: string; content: string | Uint8Array }>;
}

interface BashRequest {
  type: "sandbox-bash";
  id: string;
  command: string;
  vfsSnapshot: VfsSnapshot;  // 完整文件树
  cwd?: string;
  timeoutMs?: number;
}

interface BashResult {
  type: "sandbox-bash-result";
  id: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  vfsDiff?: Array<{ op: "add" | "modify" | "delete"; path: string; content?: string }>;
}
```

流程：
1. SW 从自己的 LIFO Sandbox 读取 session namespace 文件树（`sandbox.fs.readdir` + `readFile` 递归）
2. 序列化为 `VfsSnapshot` 发给 sandbox page
3. Sandbox page 初始化新 Sandbox 实例，写入所有文件
4. 执行 `commands.run(command)`
5. 比较执行前后 VFS，生成 diff
6. 返回 stdout/stderr/exitCode + diff
7. SW 将 diff 应用回自己的 Sandbox（fs.writeFile/rm）

#### D3: 单宿主策略（Offscreen Document）

- **唯一宿主**：SW 通过 `chrome.offscreen.createDocument()` 创建 Offscreen Document 作为 sandbox iframe 的宿主

Offscreen Document 本身的 CSP 也禁止 eval，但它可以**包含一个 sandbox iframe**，sandbox iframe 有独立 CSP。通信链：SW → Offscreen Document → sandbox iframe。

```typescript
// SW 侧 EvalBridge 伪代码
async function ensureRelay(): Promise<RelayPort> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "sandbox-host.html",
      reasons: ["WORKERS"],
      justification: "Host sandbox iframe for plugin code evaluation"
    });
  }
  return connectToOffscreen();
}
```

#### D4: 构建策略

`eval-sandbox.html` 是 manifest `sandbox.pages` 声明的扩展页面（不是注入脚本），作为标准 Vite HTML 入口构建：

```typescript
// vite.config.ts 新增入口
input: {
  sidepanel: "sidepanel.html",
  debug: "debug.html",
  "plugin-studio": "plugin-studio.html",
  "service-worker": "src/background/sw-main.ts",
  "eval-sandbox": "eval-sandbox.html",       // 新增
  "sandbox-host": "sandbox-host.html",        // 新增 (offscreen document)
}
```

可使用 `<script type="module">`，`@lifo-sh/core` 由 Vite 正常 bundle。

### 并发控制与容错

#### 请求匹配

每个请求携带唯一 `id`，sandbox page 按 `id` 回复，bridge 层用 `Map<string, { resolve, reject }>` 匹配。

#### 队列缓冲

sandbox iframe 加载完成前的请求进入 pending queue。iframe `load` 事件后 flush 队列。

#### 超时

每个请求有 `timeoutMs`（默认 120s），超时后 reject 并标记错误码 `E_SANDBOX_TIMEOUT`。

#### iframe 健康检查

bridge 维护 `lastPong` 时间戳，定期 ping。连续 3 次无响应则销毁并重建 iframe。

#### SW 重启恢复

SW 重启时发送 `{ type: "sandbox-reset" }` 通知中继宿主销毁旧 iframe 并重建。

### 不受影响确认清单

| 组件 | 影响 | 说明 |
|------|------|------|
| 预编译插件加载 (Mission HUD Dog 等) | ❌ 无影响 | 走 `import()` 路径，不经过 sandbox |
| 内置 Capability 插件 | ❌ 无影响 | 直接函数注册，不经过 sandbox |
| VFS 读写 (browser_read/write/edit_file) | ❌ 无影响 | 走 `sandbox.fs.*`，留在 SW |
| Host Bridge 工具 (host_bash 等) | ❌ 无影响 | 走 WebSocket → 本地 Bridge |
| LLM Provider | ❌ 无影响 | HTTP 调用，不涉及 eval |
| Hook 系统 | ❌ 无影响 | 函数调用链，不涉及 eval |
| CDP 浏览器操作 | ❌ 无影响 | chrome.debugger API |
| Service Worker 生命周期 | ❌ 无影响 | sandbox iframe 不影响 SW |
| SidePanel UI | ❌ 无影响 | sandbox iframe 不再直接挂在用户可见页面 |

### 其他受益场景

1. **`browser_bash` 工具回归** — 用户/Agent 可以在浏览器侧沙箱中执行 bash 命令
2. **`execute_skill_script` browser mode** — Skill 脚本在浏览器侧执行不再受限
3. **未来：用户自定义脚本执行** — 可以安全地在沙箱中运行用户提供的任意 JS 代码
4. **安全隔离增强** — sandbox page 没有 chrome.* API 权限，即使被恶意代码利用也无法访问扩展权限

## 实施计划

### Phase 1：基础设施（4 个新文件）

| 文件 | 说明 |
|------|------|
| `extension/eval-sandbox.html` | Sandbox page HTML（`<script type="module">` 加载运行时） |
| `extension/src/eval-sandbox/main.ts` | Sandbox page 逻辑：创建 LIFO Sandbox，接收 VFS 快照 + bash 命令，返回结果 |
| `extension/sandbox-host.html` | Offscreen Document HTML（内嵌 sandbox iframe + 消息中继） |
| `extension/src/sandbox-host/main.ts` | Offscreen Document 逻辑：中继 SW ↔ sandbox iframe 消息 |

### Phase 2：消息桥层

| 文件 | 说明 |
|------|------|
| 新增 `extension/src/sw/kernel/eval-bridge.ts` | SW 侧：ensureRelay() + sendBashCommand() + 请求队列 + 超时 + 健康检查 |
| 新增 `extension/src/sandbox-host/main.ts` | Offscreen 宿主：创建/管理 sandbox iframe + 消息转发 |

### Phase 3：集成

| 文件 | 变更 |
|------|------|
| `extension/manifest.json` | 添加 `"sandbox": { "pages": ["eval-sandbox.html"] }` |
| `extension/vite.config.ts` | 添加 eval-sandbox + sandbox-host 入口 |
| `extension/src/sw/kernel/browser-unix-runtime/lifo-adapter.ts` | `bashFrame()` 改用 eval-bridge |
| `extension/src/sw/kernel/runtime-router/plugin-sandbox.ts` | `invokePluginSandboxRunner()` 改用 eval-bridge |
| `extension/src/panel/main.ts` | 不再直接挂 sandbox iframe |
| `extension/src/panel/plugin-studio-main.ts` | 不再直接挂 sandbox iframe |

### 安全考量

- sandbox page 通过 `event.origin` 校验消息来源，只接受 `chrome-extension://<self-id>`
- postMessage 使用精确的 `targetOrigin`（不用 `"*"`）
- sandbox page 无 chrome.* API、无 cookie、无 localStorage（独立 origin）
- VFS 快照通过 structured clone 传递，不使用 Transferable（SW 需保留副本）
