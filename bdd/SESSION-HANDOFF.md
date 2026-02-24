# BDD 交接文档（当前基线）

更新时间：2026-02-24  
仓库路径：`/Users/envvar/work/repos/browser-brain-loop`

## 1. 当前状态

- 内核运行时已收口到 `extension/src/sw/kernel/*`，`extension/service-worker.js` 仅为 shim 入口。
- BDD 已从“单一门禁”升级为“分类门禁”：
  - `all`（默认）
  - `ux`
  - `protocol`
  - `storage`
- e2e 证据门禁已支持 `path::selector` 命中校验（不再只看 `passed=true`）。

## 2. 本轮基线文件

- 契约：`bdd/contracts/**/*.json`
- 契约分类：`bdd/mappings/contract-categories.json`
- 契约映射：`bdd/mappings/contract-to-tests.json`
- 规则说明：`bdd/README.md`
- 写作规范：`bdd/CONTRACT-WRITING-GUIDELINE.md`

## 3. 门禁命令（续跑先执行）

```bash
bun run bdd:validate
bun run bdd:gate
bun run bdd:gate:ux
bun run bdd:gate:protocol
bun run bdd:gate:storage
```

如需联动运行证据：

```bash
BRAIN_E2E_HEADLESS=true bun run brain:e2e
bun run bdd:gate
```

live profile：

```bash
bun run brain:e2e:live
bun run bdd:gate:live
```

## 4. 交接重点

1. 新增/修改契约时，必须同步更新：
   - `bdd/mappings/contract-categories.json`
   - `bdd/mappings/contract-to-tests.json`
2. 优先写“行为语义”，避免绑定内部变量名、私有 debug 路径、具体函数路径。
3. 若只改 UX 行为，可先跑 `bdd:gate:ux`；合并前仍需跑全量 `bdd:gate`。

## 5. 下一步建议（按优先级）

1. 继续清理高耦合契约措辞（实现细节 -> 行为语义）。
2. 将 `e2e` selector 覆盖扩展到更多 high-risk 契约。
3. 在 CI 按 `ux/protocol/storage` 分层并行 gate，缩短反馈时间。

