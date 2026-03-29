# Skills 加载优化建议（2026-03-28）

## 背景

当前 Skills 加载策略整体合理：

- 默认只暴露轻量 metadata catalog
- `SKILL.md` 按需加载
- `references/` 默认只提供索引

但从上下文预算、稳定路由与可扩展性角度看，仍有几项值得纳入 backlog 的优化点。

---

## 1. 限制 description 长度

### 问题
当前自动注入的 `available_skills` 目录中，主要上下文成本来自 skill `description` 的长度。

如果 skill 数量增长，且 description 写得冗长，会导致：

- catalog 本身占用过多上下文
- 模型更难快速扫描和匹配 skill
- 真实高相关 skill 被噪声淹没

### 建议
- 对 `description` 设置推荐长度区间
  - 例如：一句话，建议 20~80 个汉字或等价英文长度
- 在自动提示构造阶段增加 description 截断
- 保留原始完整 description 供技能详情页/UI 使用，但 prompt 侧使用裁剪版

### 预期收益
- 降低 catalog token 成本
- 提高 skill 路由效率
- 减少“看起来每个 skill 都像相关”的问题

---

## 2. 优化 available_skills 的排序策略

### 问题
当前自动可见 skill 目录即使有数量上限，若排序策略过于静态，也可能让真正相关 skill 不在前列。

### 建议
可以引入排序信号，例如：

1. 最近使用
2. 用户显式收藏/置顶
3. 来源优先级（project > builtin，或反之，视产品策略而定）
4. 与当前任务关键词的轻量匹配分数
5. skill 是否带有更明确的领域标签

### 预期收益
- 把高相关 skill 更早暴露给模型
- 降低 catalog 截断带来的误伤

---

## 3. 支持更强的 catalog 裁剪策略

### 问题
当前有数量上限，但当 skill 总数持续增长时，仅靠固定上限可能不够。

### 建议
- 在生成 `available_skills` 时支持：
  - 按 relevance 先筛后排
  - 分层保留（如 pinned / recent / fallback）
  - 对超出上限部分输出更紧凑的摘要或统计信息

### 预期收益
- 控制 catalog 上下文体积
- 让模型看到更高质量的技能集合

---

## 4. 控制 `<skill_resources>` 索引大小

### 问题
当前 references 正文不会自动注入，这是好的；但如果某个 skill 的 `references/` 目录很大，自动生成的索引本身也可能变重。

### 建议
- 对 reference 索引设置最大条数
- 对每条索引描述做截断
- 超出时只保留：
  - 文件名
  - 相对路径
  - 极简摘要
- 必要时在索引末尾附加：
  - `... truncated N more files`

### 预期收益
- 避免 skill resolve 后 promptBlock 变得过大
- 保持 references discoverability

---

## 5. 为 Skills 增加结构化标签

### 问题
目前 skill catalog 主要靠 `name` 和 `description` 做路由。随着技能数量增长，这种方式会逐渐不够稳定。

### 建议
考虑为 skill frontmatter 增加轻量字段，例如：

- `tags`
- `domain`
- `triggers`
- `priority`

自动 prompt 不一定全量暴露这些字段，但可用于内部排序、筛选或压缩表示。

### 预期收益
- 提高 skill 选择准确率
- 降低仅靠 description 模糊匹配的误判

---

## 6. 文档化“自动暴露 vs 显式加载”语义

### 问题
如果团队对 Skills 的暴露边界认识不一致，后续容易出现两类问题：

1. 把主 `SKILL.md` 写得过长
2. 误以为 references 会自动进上下文

### 建议
- 保持一份正式规范文档
- 在 skill authoring 文档中明确：
  - 主文件负责导航
  - reference 负责细节
  - 自动阶段只暴露 metadata
  - 正文与 references 都是按需读取

### 预期收益
- 统一团队认知
- 避免 skill 包设计退化

---

## 7. 为自动提示增加可观测性

### 问题
目前若想知道“这一轮到底自动暴露了哪些 skill”，需要看源码或 debug 结果，定位成本偏高。

### 建议
- 在 runtime debug 中增加：
  - 本轮注入的 available_skills 数量
  - 被过滤掉的 skill 数量与原因
  - 被截断的数量
- 在必要时输出 catalog token 估算

### 预期收益
- 便于优化技能策略
- 便于审计上下文预算

---

## 建议优先级

### P1
- description 长度控制
- `<skill_resources>` 索引大小控制
- 文档化自动暴露 vs 显式加载语义

### P2
- available_skills 排序优化
- catalog 裁剪策略
- runtime debug 可观测性增强

### P3
- skill 结构化标签体系

---

## 相关文档

- `docs/skills-loading-audit-2026-03-28.md`
- `docs/skills-loading-spec.md`
