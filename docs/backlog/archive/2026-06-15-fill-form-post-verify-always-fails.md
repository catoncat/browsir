# ISSUE-037: fill_form 后置验证始终失败

- id: ISSUE-037
- status: done
- created: 2026-06-15
- closed: 2026-06-15
- severity: critical

## 现象

`fill_form` 工具实际成功填入文字，但后置验证（post-verify）始终报告失败，导致 agent 误判为操作失败并反复重试，最终放弃。

用户报告："Fill Form 实际打上字了，但 agent 也不知道成功了。"

Debug snapshot 中可见：`step_finished` preview = `"fill_form 后置验证失败"`，连续两次。

## 根因

`dispatch-plan-executor.ts` 中 `fill_form` 的后置验证调用：

```typescript
const verifyOut = await executeStep({
  action: "verify",
  verifyPolicy: "off",   // ← 根因
  ...
});
if (!verifyOut.ok || verifyOut.verified !== true) {
  // 永远进入此分支
}
```

`runtime-loop.browser.ts` 中 `executeStep` 的 verify 结果赋值逻辑：

```typescript
if (verifyEnabled) {   // verifyPolicy="off" → verifyEnabled=false → 整个块被跳过
  // ...
  } else if (normalizedAction === "verify") {
    verified = toRecord(data).ok === true;  // ← 永远不执行
  }
}
```

因果链：
1. `verifyPolicy: "off"` → `shouldVerifyStep("verify", "off")` → `false`
2. `verifyEnabled = false` → `if (verifyEnabled)` 块被跳过
3. `normalizedAction === "verify"` 分支在 `if (verifyEnabled)` 内部 → 被一起跳过
4. `verified` 保持初始值 `false`
5. `verifyOut.verified !== true` → 永远为 `true` → 永远报 "后置验证失败"

所有带 `expect` 的 `fill_form` 调用均 100% 后置验证失败。同样影响通用工具后置验证（line 1146）。

## 修复

在 `runtime-loop.browser.ts` 的 `executeStep` 中，当 action 本身为 "verify" 时，即使 `verifyPolicy` 为 "off"，也应从 `verifyByCDP` 返回结果读取 `verified` 状态：

```typescript
if (
  !verifyEnabled &&
  (normalizedAction === "verify" || normalizedAction === "cdp.verify")
) {
  verified = toRecord(data).ok === true;
  verifyReason = verified ? "verified" : "verify_failed";
} else if (verifyEnabled) {
  // ...existing verify logic unchanged...
}
```

## 影响范围

- `fill_form` + `expect` 条件
- 通用工具 `plan.expect` 后置验证
- Grok.com、Cursor Help 等 Shadow DOM 重度使用页面尤为明显（LLM 更倾向添加 expect 来确认填入）

## 完成总结

修复已合入 main。`runtime-loop.browser.ts` 中 `executeStep()` 的 verify 逻辑现在当 action 本身为 `"verify"` 或 `"cdp.verify"` 时，即使 `verifyPolicy` 为 `"off"`，也会从返回结果读取 `verified` 状态。

## 相关 commits

- `c4a5f8d` docs(ISSUE-037): fill_form post-verify always fails when verifyPolicy=off
- `9007b5e` feat: auto-upgrade tracker + mixed mode CDP fallback（含 verify 修复）
