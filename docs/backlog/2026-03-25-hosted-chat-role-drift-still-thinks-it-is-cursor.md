---
id: ISSUE-041
title: hosted chat 内部 prompt 仍会先把自己识别成 Cursor
status: open
priority: p1
source: 产品文案收口对话（2026-03-25）
created: 2026-03-25
assignee: unassigned
tags: [prompt, hosted-chat, role, cursor-help, llm, ux]
---

# ISSUE: hosted chat 内部 prompt 仍会先把自己识别成 Cursor

## 现象

当前用户面文案已经收口，不再直接显示 `Cursor` / `宿主` / `provider` 等实现细节。

但实测中，`cursor_help_web` 这条 hosted chat 链路里的内部 prompt 约束仍然不稳定，模型在生成早期依旧容易先把自己当成 `Cursor`，随后才被其他上下文拉回。

这会带来两个直接问题：

- 即使 UI 已经去品牌，回答内容里仍可能冒出 `Cursor` 身份口吻
- 产品心智与执行链路脱节，用户会感知到底层品牌泄露

## 当前证据

- 代码中已有显式约束，例如 `extension/src/shared/cursor-help-web-shared.ts` 内包含 “You are not Cursor...” 之类的角色限制
- 用户反馈该约束在真实运行中“没啥用”，模型仍然首先会认为自己是 Cursor

## 初步判断

这不是单条 prompt 文案措辞的问题，更像是 hosted chat 链路的身份边界没有真正锁住，可能同时受以下因素影响：

- 上游网页原始 system / product prompt 仍强势注入了 Cursor 身份
- 当前 rewrite 策略只改写用户可见消息，没有真正覆盖最高优先级角色提示
- prompt 中“不要是什么”属于弱约束，抵不过会话上下文里的既有品牌身份
- 角色约束缺少稳定的 post-check / self-healing 机制，首段输出一旦漂移就直接暴露

## 期望方向

从第一性原理看，目标不是“写一句更凶的不要说自己是 Cursor”，而是让身份边界在系统层真正闭环：

1. 明确 hosted chat 链路里哪些上游提示拥有最高优先级
2. 校验当前 rewrite 是否真的进入了 system 层而不是只停留在 user 层
3. 若上游 system prompt 不可控，增加 response-level guard：
   - 首段品牌漂移检测
   - 发现自称 Cursor 时自动重试或重写
4. 把“产品身份”与“执行通道”拆开，避免模型把执行通道品牌误当成产品主体

## 建议排查文件

- `extension/src/shared/cursor-help-web-shared.ts`
- `extension/src/content/cursor-help-content.ts`
- `extension/src/injected/cursor-help-page-hook.ts`
- `extension/src/sw/kernel/web-chat-executor.browser.ts`

## 备注

本轮已先修复用户面品牌泄露文案；该 issue 关注的是更深一层的“模型自我身份漂移”，尚未修复。
