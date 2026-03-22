---
id: ISSUE-040
title: Skill 包主文档存在双真相与受管边界过宽
status: in-progress
priority: p1
source: 设计审查对话 2026-03-22
created: 2026-03-22
assignee: agent
claimed_at: 2026-03-22T17:20:00+08:00
tags: [skills, runtime, panel, sandbox, design-debt]
---

## 背景

当前 Skill 系统把技能包暴露为 `mem://skills/...` 文件树，这个方向本身是对的，因为 skill 不是单条配置，而是一个可读写、可执行、可 discover 的 package。

但现有实现存在两类设计债：

1. `SKILL.md` frontmatter 与 `SkillRegistry` 同时维护 `id/name/description/disableModelInvocation`，容易出现双真相漂移。
2. 之前试图把 `SKILL.md` 收口成“只能走官方入口修改”，这会把 skill 错当成受管配置，而不是支持热加载的文件包。

## 本轮修复范围

- 增加 `brain.skill.save` 作为 UI 侧可选的“保存主文档并同步安装元数据”的便利入口
- Skills 管理页改走 `brain.skill.save`，避免面板自己重复拼接“写文件 + install”流程
- 保持 Skill 作为 file package 的一等模型，允许 agent 直接创建和修改 `mem://skills/...` 文件树
- 移除对 `browser_write_file` / `browser_edit_file` / `browser_bash` 直改 `mem://skills/*/SKILL.md` 的限制

## 暂不在本轮处理

- `scripts/` / `references/` / `assets/` 的专用编辑 API
- Skill package 全量 reindex / reconcile 机制

## 工作总结

### 2026-03-22 17:24 +08:00

- 已开始第一轮收敛实现：
  - 新增 `brain.skill.save` 路由，保存主文档后同步 registry
  - Skills 管理页已切到官方保存入口
  - 通用浏览器文件工具已禁止直接修改 `mem://skills/*/SKILL.md`
  - 新增 runtime 回归测试覆盖保存主文档与直写拦截
- 残留：
  - 还需跑测试并根据结果继续收口
  - `browser_bash` 对受管 skill 包的修改边界仍未封住

### 2026-03-22 17:34 +08:00

- 继续收口一致性：
  - `brain.skill.save` 补上“写主文档 + 更新 registry”的失败回滚，避免写入成功但 registry 更新失败时留下半更新状态
  - panel store 新增测试，确认 Skills 管理页保存已走 `brain.skill.save`
  - runtime 新增回滚测试，验证 registry 更新失败时主文档会恢复原内容
- 已验证：
  - `cd extension && bun run test src/sw/kernel/__tests__/runtime-router.browser.test.ts`
  - `cd extension && bun run test src/panel/stores/__tests__/skill-store.test.ts`
  - `cd extension && bun run build`
- 当前残留：
  - `browser_bash` 仍可作为更底层写通道间接触达受管 namespace，这一层不能靠脆弱的命令字符串匹配处理，需后续设计专门的受管 namespace 策略

### 2026-03-22 18:10 +08:00

- 方向纠偏：
  - 明确 Skill 的一等模型是 file package，不是受管配置对象
  - agent 可以像处理其他代码包一样，直接创建和修改 `SKILL.md`、`references/`、`scripts/`、`assets/`
  - `brain.skill.save` 保留，但只作为 UI 和运行时的便利入口，不再作为唯一合法写路径
- 本轮调整：
  - 删除 prompt policy 对 `SKILL.md` 直改的限制性指令
  - 删除 `browser_bash` tool contract 中“不得修改 `SKILL.md`”的文案
  - 删除 runtime / browser bash 对 `mem://skills/*/SKILL.md` 的拦截测试，改为正向验证直改可用
- 当前残留：
  - `SKILL.md` frontmatter 与 registry 仍然是双真相，后续要继续收敛 discover / reindex / reconcile
  - `brain.skill.save` 与直接文件改写并存后，元数据同步策略还需要单独设计得更完整

### 2026-03-22 18:31 +08:00

- 新增产品内置 skill 机制：
  - 新增独立全局 namespace：`mem://builtin-skills/...`
  - 运行时启动会幂等 seed builtin catalog，当前先内置 `skill-authoring`
  - 若用户已经有同 ID 的非 builtin skill，seed 会跳过，不覆盖用户内容
- 收口内置 skill 保护：
  - `brain.skill.uninstall` 明确拒绝卸载 builtin skill
  - `brain.skill.save` / `brain.skill.install` / `brain.skill.create` 在命中 builtin skill 时保留 `source=builtin`，并阻止改写到其他 location
- Skills 管理页同步更新：
  - 内置 skill 显示“内置”标记
  - 内置 skill 不再显示卸载入口
  - 编辑保存时会保留原有 `source` / `enabled`，避免把 builtin 洗成普通 skill
- 已验证：
  - `cd extension && bun run test src/sw/kernel/__tests__/builtin-skills.browser.test.ts`
  - `cd extension && bun run test src/sw/kernel/__tests__/virtual-path-resolver.browser.test.ts`
  - `cd extension && bun run test src/sw/kernel/__tests__/lifo-adapter.browser.test.ts`
  - `cd extension && bun run test src/sw/kernel/__tests__/runtime-router.browser.test.ts`
  - `cd extension && bun run test src/panel/stores/__tests__/skill-store.test.ts`
  - `cd extension && bun run build`
  - `git diff --check`
- 当前残留：
  - builtin catalog 目前只有一个默认 skill，后续可继续扩展
  - 备份/导出仍未设计，本轮刻意未处理

### 2026-03-22 19:42 +08:00

- 按“内置能力 = 代码主真相，用户技能 = 用户资产”的原则继续收口：
  - `ensureBuiltinSkills()` 现在会用代码内定义覆盖回写 `mem://builtin-skills/...`，不再把运行时文件内容当真相
  - 若历史数据里已有同 ID 的非 builtin skill，会自动迁移为 `user.<builtin-id>`，保留原用户包位置，再补种 builtin
  - `brain.skill.create/install/save/disable` 对 builtin 保留 ID 与 `mem://builtin-skills/...` 统一拒绝，`enable` 对 builtin 改为幂等 no-op
  - `brain.skill.discover` 遇到 builtin 保留 ID / location 会跳过并记入 `skipped`
  - LIFO adapter 对 `mem://builtin-skills` 增加系统只读保护，只允许 builtin seed session 写入；普通 session 的 `write/edit/bash` 都会被挡住
- Skills 管理页产品语义同步修正：
  - 内置 skill 从“编辑”改成“查看”
  - 内置 skill 不再显示启用/禁用入口
  - 编辑面板对内置 skill 改成只读查看，并提示“如需定制，请新建自定义技能”
- 已验证：
  - `cd extension && bunx vitest run src/sw/kernel/__tests__/builtin-skills.browser.test.ts src/sw/kernel/__tests__/lifo-adapter.browser.test.ts src/sw/kernel/__tests__/runtime-router.browser.test.ts src/panel/stores/__tests__/skill-store.test.ts`
  - `cd extension && bunx tsc --noEmit`
  - `cd extension && bun run build`
  - `git diff --check`
- 当前残留：
  - 目前只内置了 `skill-authoring` 一个默认 skill，后续增加 catalog 时沿用同一套保留策略即可
  - “复制为自定义技能” 还没做成一键动作，当前先通过只读查看 + 新建自定义技能引导承接

## 相关 commits

- 未提交
