# Skills 最终方案汇总（Pi + AIPex，对齐 Scoped 设计）

## 0. 口径确认（以本条为准）
- Skills **只存在于浏览器侧文件系统**（虚拟 FS）。
- Skills **不需要本机文件系统副本**。
- Tool call 执行环境由 `scope` 决定；本报告不预设必须本机执行。

## 1. 结论先行
1. 采用 `resourceScope=browser`：skills 元数据与 SKILL.md 内容读取统一走浏览器 FS。
2. 采用 `execScope=by-tool-call`：skills 触发后的具体工具调用，按你们既有 scope 路由机制选择执行环境。
3. 采用 `Pi 的指令装载模式 + AIPex 的浏览器虚拟FS模式`。
4. 禁止旁路：不允许直接读宿主文件加载 skill 正文，必须走统一 resolver/provider。

## 2. Pi 调研可复用点

### 2.1 可复用
- skills 是“指令资源”，不是执行沙箱。
- progressive disclosure：提示词只放 skill 元数据，正文按需读取。
- 支持 `/skill:name` 显式触发 + 自动触发共存。
- `disable-model-invocation` 可直接沿用。

证据：
- `docs/pi-skills-support-investigation-2026-02-25.md:8`
- `docs/pi-skills-support-investigation-2026-02-25.md:9`
- `docs/pi-skills-support-investigation-2026-02-25.md:43`
- `docs/pi-skills-support-investigation-2026-02-25.md:39`

### 2.2 需规避
- Pi 在 `/skill:name` 路径有宿主直接读盘旁路（`readFileSync`）。
- 你们应统一为 resolver/provider，不允许绕过 scope 路由。

证据：
- `docs/pi-skills-support-investigation-2026-02-25.md:71`
- `docs/pi-skills-support-investigation-2026-02-25.md:99`
- `docs/pi-skills-support-investigation-2026-02-25.md:116`

## 3. AIPex 调研可复用点

### 3.1 可复用
- 浏览器 skills FS：`ZenFS + IndexedDB`，挂载 `/skills`。
- “内容/元数据分层”：
- 内容：`/skills/<skillId>/...`
- 元数据：IDB store
- 生命周期完整：上传解析 -> 启停 -> 删除 -> 刷新。

证据：
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:10`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:11`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:46`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:52`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:60`

### 3.2 需规避
- 路径安全校验偏 UI 层，内核层约束不足。
- `/skill` 输入链路到执行链路有断点风险。

证据：
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:120`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:136`
- `docs/aipex-skills-filesystem-investigation-2026-02-25.md:103`

## 4. 对 browser-brain-loop 的最终分层

### 4.1 Scope 约定
- `resourceScope=browser`
- 负责 skill zip 解包、SKILL.md、assets/references、metadata。
- `execScope`
- 不在 skills 层硬编码；由 tool call 路由层按 scope 决定。

### 4.2 唯一执行链
1. 用户触发（自然语言或 `/skill:*`）
2. `SkillRegistry` 查元数据（browser scope）
3. `SkillContentResolver` 读 SKILL.md（browser scope）
4. 组装 skill block 注入 turn
5. 后续 tool calls 按既有 capability/provider + scope 机制路由执行

### 4.3 与现有内核对齐
- 你们现有 capability/provider 路由已支持“同一工具语义，多后端执行”。
- 技能层只需补“资源侧 browser scope”的注册与读取，不应侵入执行 scope 选择逻辑。

证据：
- `docs/tool-call-layering-investigation-2026-02-25.md:20`
- `docs/tool-call-layering-investigation-2026-02-25.md:57`
- `docs/tool-call-layering-investigation-2026-02-25.md:61`
- `docs/tool-call-layering-investigation-2026-02-25.md:70`

## 5. 最小改造清单
1. 新增 `SkillRegistry`（browser scope only）
- 负责发现、去重、冲突诊断、启停状态。
- 元数据建议：`id/name/description/location/baseDir/source/enabled/updatedAt`。

2. 新增 `SkillContentResolver`（browser scope only）
- 输入：`skillId | location`
- 输出：规范化 skill block（含 baseDir 提示）
- 禁止直接文件 API 读取 skill 正文。

3. 输入链路闭环
- `/skill` 仅产生命令意图，不直接拼正文。
- 提交时由 resolver 注入，避免 UI 与执行脱节。

4. 安全下沉
- zip entry/path traversal 校验下沉到核心层。
- 统一 root 约束：skills 仅可在 browser scope `/skills` 下。

## 6. BDD 验收标准
1. `skill_load_browser_scope`
- 读取 `SKILL.md` 必须命中 browser scope provider。

2. `skill_no_direct_fs_bypass`
- 代码扫描不存在对 skill 路径的直接宿主读盘旁路。

3. `skill_scope_routing_preserved`
- skill 注入后的 tool calls 继续走现有 scope 路由规则，不被 skills 层改写。

4. `skill_security_path_zip_guard`
- 非 `/skills` 根路径、`..`、恶意 zip entry 一律拒绝。

## 7. 最终建议
- 现在可以把问题收敛为一句话：
- **Skills 是 browser scope 资源；执行 scope 由 tool call 路由层决定。**
- 这样既复用 Pi 的指令装载优点，也复用 AIPex 的浏览器虚拟FS经验，同时避免两者已有绕过/断链问题。
