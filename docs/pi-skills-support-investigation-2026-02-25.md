# Pi Skills Support Investigation (2026-02-25)

## Scope
- Repo: `~/work/repos/_research/pi-mono`
- Focus: Pi 的 skills 发现/加载/注入/调用链路，以及和四基础工具（read/write/edit/bash）的关系。

## TL;DR
- Pi 的 skills 本质是“指令资源”，不是独立执行沙箱。
- skills 只负责把“何时用哪个技能、技能文件在哪”放进 system prompt；真正执行仍走工具层。
- 自动触发路径依赖模型先用 `read` 去读 `SKILL.md`；显式触发路径是 `/skill:name`，由宿主直接读文件并包装成 `<skill>` block 注入对话。
- 这套机制可直接迁移到 browser-brain-loop，但要避免 Pi 当前一个绕过点：`/skill:name` 使用宿主 `readFileSync` 直接读盘，不经过统一 FS provider。

## 1) Skills 发现与加载

### 1.1 发现来源（代码）
- 默认自动发现来自：
- `~/.pi/agent/skills` 与 `~/.agents/skills`：`packages/coding-agent/src/core/package-manager.ts:1576`, `packages/coding-agent/src/core/package-manager.ts:1586`
- 项目 `.pi/skills`：`packages/coding-agent/src/core/package-manager.ts:1582`
- 项目及祖先目录 `.agents/skills`（到 git root 或文件系统 root）：`packages/coding-agent/src/core/package-manager.ts:303`, `packages/coding-agent/src/core/package-manager.ts:306`, `packages/coding-agent/src/core/package-manager.ts:1643`
- 额外来源：settings `skills`、package manifest `pi.skills`、CLI `--skill`：
- `packages/coding-agent/src/core/package-manager.ts:741`
- `packages/coding-agent/src/core/package-manager.ts:1372`
- `packages/coding-agent/src/main.ts:565`

### 1.2 文件匹配规则
- skills 目录下规则：根目录允许 `.md`，子目录递归只认 `SKILL.md`。
- `packages/coding-agent/src/core/skills.ts:215`, `packages/coding-agent/src/core/skills.ts:216`
- package manager 也使用同规则收集 skill entry：`packages/coding-agent/src/core/package-manager.ts:231`, `packages/coding-agent/src/core/package-manager.ts:272`

### 1.3 前置校验与容错
- Frontmatter 解析并校验 `name/description`，按 Agent Skills 规范给 warning。
- `packages/coding-agent/src/core/skills.ts:91`, `packages/coding-agent/src/core/skills.ts:120`
- 缺失 description 会跳过加载：`packages/coding-agent/src/core/skills.ts:260`
- 其余违规大多 warning 但继续加载：`packages/coding-agent/src/core/skills.ts:244`, `packages/coding-agent/src/core/skills.ts:254`
- 支持 `disable-model-invocation` 字段：`packages/coding-agent/src/core/skills.ts:69`, `packages/coding-agent/src/core/skills.ts:271`

### 1.4 去重与冲突
- 同一文件（含软链）按 realpath 去重：`packages/coding-agent/src/core/skills.ts:369`, `packages/coding-agent/src/core/skills.ts:378`
- 同名 skill 冲突“先到先得”，后者记录 collision 诊断：`packages/coding-agent/src/core/skills.ts:382`, `packages/coding-agent/src/core/skills.ts:385`

## 2) Skills 注入与调用

### 2.1 System Prompt 注入
- 注入格式为 XML `<available_skills>`，并提示“用 read 工具读取技能文件”。
- `packages/coding-agent/src/core/skills.ts:290`, `packages/coding-agent/src/core/skills.ts:298`, `packages/coding-agent/src/core/skills.ts:302`
- 每个 skill 注入 `name/description/location`：`packages/coding-agent/src/core/skills.ts:307`, `packages/coding-agent/src/core/skills.ts:309`
- `disableModelInvocation=true` 的 skill 不会进入该段：`packages/coding-agent/src/core/skills.ts:291`

### 2.2 注入条件
- 只有可用工具里存在 `read` 时才拼接 skills 段：
- 默认 prompt：`packages/coding-agent/src/core/system-prompt.ts:179`
- 自定义 prompt：`packages/coding-agent/src/core/system-prompt.ts:80`, `packages/coding-agent/src/core/system-prompt.ts:82`

### 2.3 显式命令 `/skill:name`
- 交互模式会把 skills 注册为 slash commands（`skill:<name>`）：
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:345`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts:350`
- 执行时由 `AgentSession._expandSkillCommand` 直接读 skill 文件，包成 `<skill ...>` block，再拼接用户参数：
- `packages/coding-agent/src/core/agent-session.ts:883`
- `packages/coding-agent/src/core/agent-session.ts:894`
- `packages/coding-agent/src/core/agent-session.ts:896`

### 2.4 RPC 可发现命令
- RPC `get_commands` 返回 extensions/prompts/skills 三类命令，skills 名称也是 `skill:<name>`。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts:541`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts:566`
- 协议字段：`source: "skill"`，`location`，`path`：`packages/coding-agent/src/modes/rpc/rpc-types.ts:80`, `packages/coding-agent/src/modes/rpc/rpc-types.ts:82`, `packages/coding-agent/src/modes/rpc/rpc-types.ts:84`

## 3) 与四基础工具的关系（第一性原理）
- read/write/edit/bash 是执行原语，skills 是任务策略与流程描述。
- 默认工具集是四工具：`packages/coding-agent/src/core/tools/index.ts:82`
- system prompt 明确把技能读取动作绑定到 `read` 工具：`packages/coding-agent/src/core/skills.ts:299`
- 但是 `/skill:name` 这条显式路径读取 skill 文件时，绕过了 `read` 工具，走了宿主直接文件读取：`packages/coding-agent/src/core/agent-session.ts:894`

## 4) 安全边界
- Pi 文档明确提示 skills 可能驱动任意动作，第三方包需审计：
- `packages/coding-agent/docs/skills.md:22`
- `packages/coding-agent/README.md:337`
- 技术上，四工具支持 operations override（可换后端），但默认是本机 FS/本机 shell：
- read override: `packages/coding-agent/src/core/tools/read.ts:27`
- write override: `packages/coding-agent/src/core/tools/write.ts:18`
- edit override: `packages/coding-agent/src/core/tools/edit.ts:35`
- bash override: `packages/coding-agent/src/core/tools/bash.ts:35`
- path 解析默认是相对 cwd 或绝对路径，不是强制根目录沙箱：`packages/coding-agent/src/core/tools/path-utils.ts:54`
- docs 里提到 `allowed-tools`，但核心执行链未见 enforcement（仅作为文档字段说明）：`packages/coding-agent/docs/skills.md:147`

## 5) Mom 子项目的 skills 用法（同仓参考）
- Mom 复用了 `loadSkillsFromDir` 与 `formatSkillsForPrompt`：`packages/mom/src/agent.ts:9`, `packages/mom/src/agent.ts:8`
- 加载规则是 workspace 级 + channel 级，channel 同名覆盖 workspace：`packages/mom/src/agent.ts:121`, `packages/mom/src/agent.ts:130`
- Mom 把 host path 翻译为容器 path 后注入 prompt：`packages/mom/src/agent.ts:114`, `packages/mom/src/agent.ts:125`
- 但 Mom 的 `ResourceLoader.getSkills()` 返回空，skills 不走 coding-agent 标准资源管线：`packages/mom/src/agent.ts:453`, `packages/mom/src/agent.ts:455`

## 6) 对 browser-brain-loop 的可迁移结论

### 6.1 可直接借鉴
- progressive disclosure：提示词只放 skill 元数据，正文按需加载。
- 统一 skills 注册结构：`name/description/location/baseDir/source/disableModelInvocation`。
- 支持来源分层：global/project/ancestor/package/CLI/extension 动态注入。

### 6.2 必须改造（和你们“本机+浏览器虚拟FS并存”强相关）
- 禁止任何绕过 FS provider 的“直接读盘”技能加载路径。
- Pi 的 `_expandSkillCommand` 是绕过点，browser-brain-loop 不应复制。
- skill 加载应复用你们现有四工具能力抽象（本机 bridge provider / 浏览器虚拟 FS provider），至少在 read 语义上统一。
- 建议把 skills 加载收敛到一个 `SkillContentResolver`：
- 输入 skill `location`
- 通过当前 session 的 FS capability 执行 read
- 返回标准化 skill block 给 planner/loop

### 6.3 安全基线建议
- 明确 `disable-model-invocation` 语义。
- 如要支持 `allowed-tools`，在 runtime 层做 hard enforcement，不只放 frontmatter。
- 对第三方 skill/package 增加 provenance 与审计标识（source/path/hash）。

## 7) 和你们当前状态的对齐建议（最小闭环）
1. 先做 `SkillRegistry`（只做发现、去重、元数据）。
2. 再做 `SkillResolver`（只做通过 FS provider 读取 skill 内容）。
3. 在 system prompt 里注入 `<available_skills>` 元数据，保留按需读取策略。
4. 实现显式命令触发时也走 `SkillResolver`，不要直接 `readFileSync`。
5. 最后补 BDD：
- 同一 skill 在本机 FS 与浏览器虚拟 FS 都可读取。
- `disable-model-invocation` 生效。
- provider 切换不改变 skills 语义，只改变底层文件后端。

