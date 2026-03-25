# Tool Call 流式文本体验研究（2026-03-25）

> 日期：2026-03-25  
> 背景：在 SidePanel 中，模型进入工具调用前会先流出一小段自然语言说明，但这段文字随后会被清空，界面切到工具执行卡。用户主观感受是“刚说的话被撤回了”，观感不稳定。  
> 目标：澄清当前行为到底是实现副作用、刻意设计，还是行业通用做法；给后续交互改造提供一份统一结论。

## 1. 现象定义

当前链路里，用户会看到这样的过程：

1. 助手先流出一句解释，例如“我先去找输入框”
2. 这句话很快被清掉
3. UI 切成工具执行卡
4. 工具结束后再回到下一轮生成

从用户视角，这种体验有三个问题：

1. 像“助手撤回了刚才的话”
2. 时间线不连续，难以判断刚才到底发生了什么
3. 如果一轮里有多个工具，界面会反复闪烁，像在“说一句删一句”

## 2. 当前实现到底在做什么

这不是偶发副作用，而是当前实现的明确选择。

### 2.1 数据层其实保留了“文本 + 工具调用”

内核在拿到模型回复后，会同时解析：

- `assistantText`
- `toolCalls`

并且会把两者一起放进当前 assistant 回合的内容块里。可见：

- `extension/src/sw/kernel/runtime-loop.browser.ts:2311`
- `extension/src/sw/kernel/runtime-loop.browser.ts:2323`

这意味着：**系统在数据语义上并没有丢掉“工具调用前的自然语言说明”**。

此外，针对 Cursor Help 宿主聊天的测试也明确验证了：

- 同一回合里带 `tool_calls` 时，`assistantText` 仍然应该存在
- 只是它不一定会被前端稳定展示出来

参考：

- `extension/src/sw/kernel/__tests__/web-chat-executor.browser.test.ts:562`
- `extension/src/sw/kernel/__tests__/cursor-help-web-shared.browser.test.ts:38`

### 2.2 正式消息列表故意不写入这段中间文本

当前内核只会在“本轮没有工具调用”的时候，把 assistant 文本正式写入消息列表：

- `extension/src/sw/kernel/runtime-loop.browser.ts:2328`

代码注释写得很明确：

> 含 `tool_calls` 的中间阶段，只通过流式态和工具步骤卡展示，避免正文被切碎成多段。

所以现在的真实策略是：

- **最终回答**：进入正式聊天记录
- **工具前说明**：只当作临时草稿，不进入正式聊天记录

### 2.3 前端在工具调用到达时主动把草稿清空

UI 层的 `use-llm-streaming` 对两类事件会主动重置草稿：

1. `hosted_chat.tool_call_detected`
2. `hosted_chat.turn_resolved` 且 `finishReason === "tool_calls"`

对应代码：

- `extension/src/panel/composables/use-llm-streaming.ts:155`
- `extension/src/panel/composables/use-llm-streaming.ts:165`

也就是说，当前体验中的“文字消失”并不是渲染偶发，而是前端明确在做：

- 先把流式草稿展示出来
- 一旦确认这轮要进工具调用，就把草稿清掉

### 2.4 工具卡会接管当前视觉焦点

在消息区里，流式草稿和工具执行卡是两个独立块：

- `StreamingDraftContainer`
- `tool_pending` 卡片

参考：

- `extension/src/panel/ChatView.vue:801`
- `extension/src/panel/ChatView.vue:808`

一旦 `step_planned(mode=tool_call)` 到来，运行态就切到 `tool_running`：

- `extension/src/panel/composables/use-tool-run-tracking.ts:389`

因此用户的感知不是“同一个 assistant 回合继续展开”，而是：

- 草稿消失
- 工具卡顶上来

## 3. 这是不是行业通用做法

结论先说：

- **把工具调用和普通文本分开建模**，是行业常见做法
- **把已经展示出来的自然语言说明清掉**，不是行业必须做法，也不是唯一主流

### 3.1 行业共识：数据模型会把文本和工具分开

几个主流体系都在数据层明确区分：

1. **OpenAI**
   - 函数调用/工具调用作为独立输出项处理
   - 文本输出和工具调用不是同一种对象
   - 参考：<https://developers.openai.com/api/docs/guides/function-calling>

2. **Anthropic**
   - assistant 回合可以包含 `text` 和 `tool_use`
   - 在某些强制工具模式下，模型甚至可能直接出 `tool_use` 而不先说解释
   - 参考：<https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use>

3. **Vercel AI SDK**
   - UI 层把工具调用视作 message `parts`
   - 多步工具调用还支持 `step-start` 等中间结构
   - 参考：<https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage>

这说明行业共识是：

- “文本”和“工具”应在协议层拆开
- 但**协议层拆开**不等于**UI 层必须把文本擦掉**

### 3.2 行业并没有要求“先显示，再清空”

从这些体系的设计看，更常见的是：

1. 保留同一 assistant 回合的结构化 parts
2. 在 UI 中把文本解释、工具调用、工具结果连续展示
3. 用状态变化表达“现在进入工具阶段”，而不是删除刚才已经展示的说明

Anthropic 文档甚至专门说明：

- 某些 `tool_choice` 模式下不会先出文字解释
- 但这属于模型输出策略，不是前端在拿到解释后再主动撤回

换句话说：

- **“不出现解释”** 可以是合理模型行为
- **“已经出现的解释又被前端删掉”** 更像一种 UI 取舍，而不是行业标准

## 4. 对当前方案的判断

### 4.1 当前方案的优点

1. 正式消息列表比较干净，不会堆满半成品
2. 工具步骤卡能承载结构化状态，便于调试
3. 逻辑上容易区分“最终回答”与“中间执行”

### 4.2 当前方案的问题

1. **用户心理不连续**
   - 用户已经读到了自然语言解释，但系统马上把它抹掉

2. **时间线断裂**
   - 看起来不是“同一个 assistant 回合在推进”，而像“UI 重新渲染了一次”

3. **多工具时放大违和感**
   - 每一轮工具 handoff 都会重复这个清空动作

4. **当前测试也把这种体验固化了**
   - `withholds provisional text when the turn resolves to tool_calls`
   - 说明这不是无意 bug，而是被当前测试门禁保护的产品行为

## 5. 更合理的产品方向

### 5.1 推荐方向

推荐把“工具前自然语言解释”从“临时草稿”升级为“稳定可见的 assistant 说明”，但只限于**用户可读的自然语言**。

具体做法：

1. 若模型已经输出了一段自然语言解释，且这段文本不是协议噪音
   - 不要在 `tool_call_detected` 时清掉

2. 工具执行卡继续保留
   - 但放在这段文字下面，作为同一轮 assistant 行为的后续步骤

3. 正式消息列表可继续避免写入原始协议片段
   - 比如 `[TM_TOOL_CALL_START:*]`
   - 只保留“用户能读懂”的文字说明

4. 如果担心消息碎片化
   - 可以把这段解释写成“本轮计划 / 正在执行”
   - 而不是伪装成它从未出现

### 5.2 不推荐的方向

1. 继续沿用“出现即清空”
   - 用户感知会一直像撤回消息

2. 把所有流式草稿都永久写入正文
   - 会把真正的半成品和协议噪音也带进来

3. 只靠工具卡表达意图
   - 对普通用户不够自然

## 6. 可落地的后续改造建议

### 方案 A：最小改造

目标：不动消息模型，只调前端展示。

做法：

1. `hosted_chat.tool_call_detected` 不再 `resetLlmStreamingState()`
2. 将最后一段可读草稿保留到工具卡结束
3. 工具卡作为辅助状态块出现在草稿下方

优点：

- 改动面小
- 很快能验证观感

风险：

- 草稿与最终 assistant 消息之间可能出现重复，需要后续去重

### 方案 B：推荐的完整方案

目标：把“说明文字 + 工具步骤”视作同一 assistant 回合的两个展示层。

做法：

1. 数据层保留 assistant mixed content
2. UI 把 assistant 自然语言说明固化为稳定消息
3. 工具步骤作为这条 assistant 消息的“展开步骤”或“内联状态”
4. 最终回答回来后，继续追加到同一轮 assistant timeline 中

优点：

- 连续性最好
- 最接近用户对“助手正在做事”的心理模型

风险：

- 需要调整现有消息渲染与去重策略
- 需要同步更新测试门禁

## 7. 本次研究结论

这次问题的核心，不是“工具调用和文本要不要分开”，而是：

> 我们把“避免正文碎片化”做得过头了，导致已经展示给用户的自然语言解释被主动撤回。

因此最值得保留的结论是：

1. 当前行为是**刻意实现**，不是偶发 bug
2. 行业共识是“文本和工具分开建模”，**不是**“先显示再清空”
3. 从产品体验看，应该优先保留“用户可读的解释文字”，而不是保留“只对系统有意义的协议片段”

## 8. 参考

### 项目内代码与测试

- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/panel/composables/use-llm-streaming.ts`
- `extension/src/panel/composables/use-tool-run-tracking.ts`
- `extension/src/panel/ChatView.vue`
- `extension/src/sw/kernel/__tests__/web-chat-executor.browser.test.ts`
- `extension/src/sw/kernel/__tests__/cursor-help-web-shared.browser.test.ts`

### 外部参考

- OpenAI Function Calling Guide  
  <https://developers.openai.com/api/docs/guides/function-calling>

- Anthropic Tool Use Guide  
  <https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use>

- Vercel AI SDK UI: Chatbot Tool Usage  
  <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage>
