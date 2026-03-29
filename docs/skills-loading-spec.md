# Skills 加载规范

## 目标

定义 Browser Brain Loop 中 Skills 的默认暴露、按需加载与上下文控制规则，避免 skill 内容无边界进入模型上下文。

## 设计原则

1. **默认轻量**
   - 默认只向模型暴露 skill catalog 的轻量元信息。
   - 不在启动时或默认每轮中加载所有 `SKILL.md` 正文。

2. **按需加载**
   - 只有当用户显式选择 skill，或模型/流程显式请求 skill 时，才加载该 skill 的正文。

3. **参考资料分层**
   - `references/` 默认只暴露索引，不自动加载正文。
   - 读取具体 reference 文件必须显式触发。

4. **可控可裁剪**
   - 自动暴露的 skill 数量、描述长度、reference 索引大小都应可控。

5. **可解释**
   - 必须能清楚说明：哪些是自动注入，哪些是显式注入，哪些是按需读取。

---

## 一、自动暴露规范

### 自动暴露对象
仅自动暴露满足以下条件的 skill：

- `enabled === true`
- `disableModelInvocation !== true`

### 自动暴露字段
自动阶段仅应包含轻量 metadata，推荐字段为：

- `name`
- `description`
- `location`
- `source`

### 自动阶段禁止项
默认不应自动注入：

- `SKILL.md` 正文
- `references/*` 正文
- `scripts/*` 内容
- `assets/*` 内容

### 自动暴露形式
推荐使用单独的 catalog block，例如：

```xml
<available_skills>
  <skill name="..." description="..." location="..." source="..." />
</available_skills>
```

---

## 二、显式加载规范

### 允许触发正文加载的场景
仅在以下场景加载 skill 正文：

1. 用户通过 `/skill` 显式选择
2. 用户通过 UI 显式选择 skill
3. 模型根据 catalog 判断相关后，显式调用 `load_skill`
4. 系统内部明确要求解析指定 skill

### 正文加载内容
当 skill 被显式解析时，可以注入：

- `SKILL.md` 正文
- 轻量的 `references/` 索引增强块

推荐形式：

```xml
<skill id="..." name="..." location="..." source="...">
  ...SKILL.md 正文...

  <skill_resources>
    ...references 索引...
  </skill_resources>
</skill>
```

---

## 三、References 规范

### 默认行为
- `references/` 不自动全文注入模型上下文。
- 仅在 skill 被解析时，提供 reference 索引或目录提示。

### 正文读取
读取 reference 正文必须显式调用：

- `read_skill_reference`

### 编写建议
- 长文、示例、清单、案例、补充说明应放在 `references/`
- 主 `SKILL.md` 只保留任务目标、路径、规则、输出格式

---

## 四、Skill 编写规范

### 主文件（`SKILL.md`）
应保持：

- 短
- 稳
- 可扫描
- 面向执行

推荐包含：

1. 目标
2. 使用时机
3. 路径/步骤
4. 工作规则
5. 输出模板
6. references 索引

不推荐在主文件中堆积：

- 大段背景资料
- 长案例
- 过多实现细节
- 大量附录型说明

### References
适合存放：

- checklist
- decision tree
- key paths
- output template
- examples
- design notes

---

## 五、上下文控制规范

### 目录层
- 应设置自动可见 skill 数量上限
- 应优先显示对当前任务最相关的 skill

### 描述层
- `description` 应短、准、能路由
- 避免 description 过长导致 catalog 膨胀

### 正文层
- `SKILL.md` 应尽量控制长度
- 若正文过长，应继续拆到 `references/`

### 参考索引层
- `<skill_resources>` 只放索引，不放全文
- 目录项过多时应截断或摘要化

---

## 六、推荐的团队口径

对外可统一描述为：

> Skills 默认只以 metadata catalog 的形式暴露给模型；`SKILL.md` 仅在显式选择或显式加载时注入；`references/` 默认只提供索引，不自动加载正文。

---

## 七、当前实现对照

当前实现整体符合本规范：

- 默认自动暴露 metadata catalog
- 过滤 `disableModelInvocation`
- 限制自动可见 skill 数量
- `SKILL.md` 按需加载
- `references/` 默认只做索引增强

需要继续优化的主要方向：

- description 长度控制
- available_skills 排序/裁剪策略
- `<skill_resources>` 体积控制

---

## 参考文档

- `docs/skills-loading-audit-2026-03-28.md`
- `docs/backlog/2026-03-28-skills-loading-optimization.md`
