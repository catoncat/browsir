# Skills 加载行为审计（2026-03-28）

## 结论摘要

当前实现**不会在启动时或默认每轮中把所有已启用 Skills 的完整 `SKILL.md` 全文注入模型上下文**。

默认行为是：

1. 运行时构造 prompt 时，生成一个轻量的 `available_skills` 列表。
2. 列表中每个 skill 只暴露元信息：
   - `name`
   - `description`
   - `location`
   - `source`
3. 只有在显式选择或显式解析某个 skill 时，才会加载该 skill 的 `SKILL.md` 正文。
4. `references/` 不会自动全文加载；只会在 skill 被解析时附加一个轻量索引块，提示模型按需再读取具体 reference 文件。

这套行为整体上**符合“默认只暴露技能描述、正文按需加载、避免上下文膨胀”的最佳实践方向**。

---

## 一、默认自动注入了什么

### 注入内容
默认自动注入的是一个 `available_skills` 目录提示，而不是 skill 正文。

生成逻辑位于：

- `extension/src/sw/kernel/prompt/prompt-policy.browser.ts`
- 函数：`buildAvailableSkillsSystemMessage(skills)`

其输出形式为：

```xml
<available_skills>
  <skill name="..." description="..." location="..." source="..." />
</available_skills>
```

### 自动阶段包含的字段
每个 skill 自动暴露给模型的字段只有：

- `name`
- `description`
- `location`
- `source`

### 自动阶段不会包含的内容
默认不会自动注入：

- `SKILL.md` 正文
- `references/*` 正文
- `scripts/*` 内容
- `assets/*` 内容

---

## 二、哪些 Skills 会进入自动提示

自动提示只包含：

- `enabled === true` 的 skill
- 且 `disableModelInvocation !== true` 的 skill

相关逻辑同样位于：

- `extension/src/sw/kernel/prompt/prompt-policy.browser.ts`

此外还有数量上限：

- `MAX_PROMPT_SKILL_ITEMS = 64`

因此当前实现已经具备两层上下文控制：

1. 过滤禁用自动调用的 skill
2. 限制最大自动暴露条数

---

## 三、available_skills 是在什么阶段进入 prompt 的

`available_skills` 不是在扩展启动时一次性预加载进上下文，而是在**每次 runtime loop 构造模型消息时**生成。

相关代码位于：

- `extension/src/sw/kernel/runtime-loop.browser.ts`

关键流程：

```ts
const skills = await orchestrator.listSkills();
availableSkillsPrompt = buildAvailableSkillsSystemMessage(skills);

const messages = applyLatestUserPromptOverride(
  await buildLlmMessagesFromContext(
    systemPrompt,
    meta,
    context.messages,
    availableSkillsPrompt,
    ...
  ),
  prompt,
);
```

这说明：

- `availableSkillsPrompt` 是消息构造阶段的系统级上下文增强
- 不是用户手动输入的一部分
- 也不是扩展启动时把所有 skills 正文提前塞进去

---

## 四、完整 `SKILL.md` 什么时候才会加载

完整正文只有在**显式解析 skill** 时才会被读取。

相关代码位于：

- `extension/src/sw/kernel/skill-content-resolver.ts`
- 方法：`resolveById(skillId, options)`

该方法会：

1. 根据 skill id 找到 metadata
2. 读取 `location` 指向的 `SKILL.md`
3. 构造成一个 `<skill ...>...</skill>` prompt block

格式大致如下：

```xml
<skill id="..." name="..." location="..." source="...">
  ...SKILL.md 正文...
</skill>
```

因此，**完整 skill 正文是按需加载，不是默认全量加载**。

---

## 五、哪些路径会触发 skill 正文加载

### 1. `/skill` 显式调用
相关代码：

- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `parseSkillSlashPrompt`
- `expandSkillSlashPrompt`

当用户使用 `/skill` 时，系统会解析目标 skill，并将其 prompt block 注入模型输入。

### 2. UI 中显式选择 skill
相关代码：

- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `expandExplicitSelectedSkillsPrompt`

其中存在：

```ts
promptBlocks.push(resolved.promptBlock);
```

说明用户在输入框或 UI 层显式选中的 skill，会被完整解析并注入 prompt。

### 3. 模型/流程显式调用 `load_skill`
模型看到 `available_skills` 中的元信息后，可以再调用：

- `load_skill`

此时也属于按需读取正文。

---

## 六、`references/` 会不会自动一起加载

### 结论
**不会自动把 `references/` 的正文全文加载进 prompt。**

但在 skill 被解析时，系统会自动附加一个轻量的 `references` 索引块，而不是 reference 内容全文。

相关代码位于：

- `extension/src/sw/kernel/runtime-loop.browser.ts`
- 通过 `orchestrator.setSkillPromptAugmenter(...)`

核心行为：

1. 找到 skill 的 `references/` 目录
2. 构建目录索引
3. 将索引包装为 `<skill_resources>...</skill_resources>`

生成内容示意：

```xml
<skill_resources>
  以下是该 skill package 内可按需读取的本地 references 索引；仅在需要时再调用 read_skill_reference 读取具体文件。
  ...references 索引...
</skill_resources>
```

这意味着：

- `references/*` 正文默认不进上下文
- 模型只会先看到“有哪些 reference 可读”
- 真正需要时再通过 `read_skill_reference` 读取具体文件

这是一种较好的折中设计：

- 保留 skill discoverability
- 避免大段 reference 正文自动撑爆上下文

---

## 七、当前实现与最佳实践的对照

### 已符合的点

1. **默认不加载所有 skill 正文**
2. **自动阶段只暴露轻量 metadata**
3. **正文按需解析**
4. **references 采用索引提示而不是全文自动注入**
5. **支持 `disableModelInvocation` 隐藏 skill**
6. **有自动可见 skill 数量上限**

### 与“最极简规范”的差异

当前自动提示不只包含 `description`，还包含：

- `name`
- `location`
- `source`

这比“只暴露 description”多一点点信息，但仍属于轻量元数据，通常不会造成明显上下文压力。

因此更准确地说，当前实现是：

> **默认暴露轻量 skill catalog，而不是只暴露单一 description 字段。**

---

## 八、对当前实现的总体判断

当前 Skills 加载策略可以概括为：

> **目录先暴露，正文按需加载，reference 仅自动暴露索引。**

如果要用一句更规范的话来描述：

> **Skills 默认只以 metadata catalog 的形式暴露给模型；`SKILL.md` 仅在显式选择或显式加载时注入；`references/` 默认仅提供索引，不自动加载正文。**

这是一个比较接近行业最佳实践的实现。

---

## 九、后续可考虑的优化点

虽然当前方向合理，但仍有一些可以继续优化的点：

1. **限制 description 长度**
   - 当前自动目录的上下文压力主要来自 description 文本质量与长度。

2. **可考虑让 `available_skills` 支持更强的截断/排序策略**
   - 例如按最近使用、来源、tag、优先级排序，而不仅仅是字母序。

3. **对 `<skill_resources>` 索引做大小控制**
   - 当某个 skill 的 references 很多时，索引本身也可能增长。

4. **进一步文档化自动 vs 显式加载语义**
   - 便于团队统一 skill 编写规范。

---

## 证据路径

### 核心文件
- `extension/src/sw/kernel/prompt/prompt-policy.browser.ts`
- `extension/src/sw/kernel/runtime-loop.browser.ts`
- `extension/src/sw/kernel/skill-content-resolver.ts`

### 核心观察点
- `buildAvailableSkillsSystemMessage(skills)`
- `availableSkillsPrompt = buildAvailableSkillsSystemMessage(skills)`
- `buildLlmMessagesFromContext(systemPrompt, meta, context.messages, availableSkillsPrompt, ...)`
- `resolveById(skillId, options)`
- `promptBlocks.push(resolved.promptBlock)`
- `expandSkillSlashPrompt(...)`
- `setSkillPromptAugmenter(...)`
- `<skill_resources>`
