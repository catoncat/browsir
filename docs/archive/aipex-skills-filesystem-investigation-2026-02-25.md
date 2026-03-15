# AIPex 调研：插件内文件系统与 Skills 实现（2026-02-25）

## 范围
- 目标仓库：`/Users/envvar/work/repos/_research/AIPex`
- 调研问题：
  1. 浏览器插件内“文件系统”如何实现
  2. Skills 如何实现与接入 Agent/tool_call 闭环

## TL;DR
- AIPex 用 `ZenFS + IndexedDB` 在插件内实现了持久化虚拟文件系统，挂载根为 `/skills`。
- Skills 采用“文件内容与元数据分层存储”：
  - 文件内容：ZenFS(`/skills/<skillId>/...`)
  - 元数据：IndexedDB(`AIPexSkills.skills`)
- Skills 生命周期完整（上传/启停/卸载/元数据刷新），并通过 `skill tools` 暴露给 Agent。
- `/skill` UI 选择链路存在“提交未真正进入聊天执行上下文”的断点，需要避免照抄该问题。

## 1. 插件内文件系统实现

### 1.1 存储后端与挂载
- ZenFS 使用 IndexedDB backend：
  - `@zenfs/core` / `@zenfs/dom`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:6`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:7`
- 挂载点固定 `/skills`，storeName 为 `aipex-skills-fs`：
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:48`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:50`
- 初始化时确保 `/skills` 目录存在：
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:57`

### 1.2 API 形态
- ZenFSManager 提供完整文件能力：`read/write/readdir/mkdir/rm/stat` 等。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:105`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:125`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:160`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:174`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:193`

### 1.3 启动预热
- Sidepanel 启动预热 `zenfs + quickjs`，减少首次脚本执行冷启动：
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/pages/sidepanel/index.tsx:5`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/pages/sidepanel/index.tsx:9`

## 2. Skills 数据与生命周期

### 2.1 元数据存储
- 元数据在独立 IndexedDB：`DB=AIPexSkills`，`store=skills`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:151`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:153`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:182`

### 2.2 上传与解压
- 上传 ZIP 后解析 `SKILL.md` frontmatter，确定 skill id/name。
- 解压到 ZenFS：`/skills/<skillId>`。
- 再写 metadata 到 IndexedDB。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:190`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:217`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:229`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:141`

### 2.3 启停与卸载
- enable: 更新 enabled 状态，必要时加载技能。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:341`
- disable: 更新状态但不强制卸载文件。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:379`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:401`
- delete: 先卸载注册，再删 IndexedDB + ZenFS 目录。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:419`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/storage/skill-storage.ts:270`

### 2.4 元数据刷新
- 编辑 `SKILL.md` 后可刷新 frontmatter 到元数据与 registry。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:458`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:495`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:515`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:529`

## 3. Skills 运行时执行

### 3.1 文件发现约定
- 技能结构约定：`SKILL.md` + `scripts/` + `references/` + `assets/`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:229`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:251`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:273`

### 3.2 执行引擎
- `SkillExecutor` 初始化：`zenfs -> quickjs -> migration`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-executor.ts:26`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-executor.ts:30`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-executor.ts:34`
- 脚本执行时 workingDir 绑定 skill 目录。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-executor.ts:199`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-executor.ts:203`

### 3.3 VM 能力面
- `SKILL_API.fs`（读写目录/状态，同步+异步）+ `fetch` + `download`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/skill-api.ts:31`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/skill-api.ts:98`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/skill-api.ts:221`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/skill-api.ts:253`

## 4. Agent Tool Call 接入

### 4.1 Skills 工具集合
- skill tools：
  - `load_skill`
  - `execute_skill_script`
  - `read_skill_reference`
  - `get_skill_asset`
  - `list_skills`
  - `get_skill_info`
- 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/tools/skill.ts:6`
- 注入默认工具集合：
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/tools/index.ts:100`

### 4.2 输入侧 `/skill` 选择链路
- PromptInput 支持 `/` 触发 skill 选择并写入 `skills` 字段。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/aipex-react/src/components/ai-elements/prompt-input.tsx:1235`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/aipex-react/src/components/ai-elements/prompt-input.tsx:1149`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/aipex-react/src/components/ai-elements/prompt-input.tsx:851`
- 但默认 input-area 提交时未向 agent 透传 `skills`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/aipex-react/src/components/chatbot/components/input-area.tsx:162`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/aipex-react/src/components/chatbot/components/input-area.tsx:177`

## 5. 安全边界与风险

### 5.1 已有边界
- UI/Adapter 层限制写路径必须在 `/skills/`，并禁止 `..`。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/pages/options/file-components/FilePreview.tsx:47`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/pages/options/file-components/FilePreview.tsx:51`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/lib/skill-client-adapter.ts:99`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-ext/src/lib/skill-client-adapter.ts:103`
- `refreshSkillMetadata` 对 skillId 做基础防穿越。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/services/skill-manager.ts:463`

### 5.2 风险
- 底层 ZenFS API 本身未统一强约束 path（更依赖调用方自律）。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:105`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/lib/vm/zenfs-manager.ts:125`
- ZIP 解压未看到显式 `..` path traversal 拒绝逻辑。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:189`
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/skill/lib/utils/zip-utils.ts:199`
- `execute_skill_script` 仅做 `scripts/` 前缀归一，不是严格白名单路径校验。
  - 证据：`/Users/envvar/work/repos/_research/AIPex/packages/browser-runtime/src/tools/skill.ts:47`

## 6. 对 browser-brain-loop 的直接启发
- 你们可复用“文件内容与元数据分层存储”思想，但要把路径与 zip-entry 校验下沉到统一核心层，而不是只在 UI 层校验。
- skills 接入优先走“tool contract + capability provider”统一路由，避免再做一套旁路执行系统。
- 输入层（`/skill`）和执行层（LLM 实际可调用工具）必须闭环验证，避免出现“UI 选了 skill 但运行时没用到”的断链。
