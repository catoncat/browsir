# ISSUE-034: Sandbox 路径遍历防御 + CDP Debug 安全加固

- **优先级**: P1
- **来源**: Round 4+5 Review (2026-03-15)
- **状态**: Open

## 问题描述

Sandbox 路径规范化模块存在路径遍历防御缺口，CDP Debug 工具 serve 模式缺少鉴权。两者均涉及安全风险。

## 待办

### Sandbox（来自 Round 4）

1. **resolveVirtualPath 路径遍历防御** [HIGH]
   - 在 namespace 分发前添加早期断言，拒绝包含 `..` 的路径
   - 或在入口统一调用 normalizeRelativePath

2. **为 resolveVirtualPath + normalizeRelativePath 添加单元测试** [INFO→MEDIUM]
   - 覆盖 `../`、`../../`、空路径、`mem://../` 等边界情况

### CDP Debug（来自 Round 5）

3. **serve 模式添加鉴权** [HIGH]
   - 为 /eval 和 /sw-eval 端点添加 Bearer token
   - 参考 BRIDGE_TOKEN 模式

4. **DevToolsActivePort 端口号校验** [MEDIUM]
   - 校验 1-65535 范围

5. **BrowserSession 消除 any 强转** [MEDIUM]
   - 向 CdpClient 暴露公共 isConnected() 方法

6. **PersistentCdpPool 添加 session 过期/淘汰** [MEDIUM]
   - TTL 或 LRU 策略

7. **getSession 并发去重** [MEDIUM]
   - 用 Promise 锁防止同 tabId 重复创建 session

## 验收标准

- `mem://../../../` 路径被拒绝
- serve 模式无 token 时返回 401
- `bun run build` 通过
- `bun run test` 全部通过
