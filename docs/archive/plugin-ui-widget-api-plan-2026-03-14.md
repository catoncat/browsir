# Plugin UI Widget API 实施计划（2026-03-14）

> 目标：把 `plugin.example.ui.mission-hud.dog` 从“插件发消息、宿主写死 UI”重构为“插件自带 UI，宿主只提供挂载位与生命周期”。

---

## 1. 背景

当前 `mission-hud-dog` 的真实实现是：

- `index.js` 在 Service Worker 侧监听 hook，发送 `bbloop.ui.mascot`
- `App.vue` 在 Panel 侧监听 `bbloop.ui.mascot`
- `MissionMascot.vue` 在宿主里直接渲染狗的 SVG、动画和气泡

这会造成一个认知问题：

- 插件名看起来像“插件自带 UI 示例”
- 但实际上 UI 是宿主写死的

因此需要把它重构成真正的插件 UI 示例。

---

## 2. 本轮目标

本轮只做 **Panel / SidePanel 内的插件自带 UI**，不做网页注入增强。

### 2.1 要达成的结果

1. Panel UI runtime 支持插件注册 widget
2. 宿主提供合法挂载位（slot）
3. 插件 `ui.js` 可以把自己的 UI 挂到 slot 里
4. enable / disable / unregister 时有正式 mount / unmount / cleanup 生命周期
5. `mission-hud-dog` 迁移为真正插件自带 UI
6. 删除宿主硬编码的 `MissionMascot.vue` 链路

### 2.2 明确不做

1. 不做页面注入 / content script UI 增强
2. 不做类似油猴的网页 DOM 增强能力
3. 不做 `mem:// ui.js` 在 Panel 侧真实执行的完整支持扩展
4. 不引入多 slot 体系，v1 只做最小闭环

---

## 3. 方案选择

采用 **方案 A：宿主 slot + widget API**。

核心原则：

- 宿主负责提供挂载位与生命周期
- 插件负责自己的 UI 实现
- `ui.on(...)` 继续用于 patch / block 宿主现有渲染流程
- `ui.registerWidget(...)` 专门用于插件自带 UI

---

## 4. v1 最小能力边界

### 4.1 仅开放一个 slot

```ts
export type UiWidgetSlot = "chat.scene.overlay";
```

用途：

- HUD
- mascot
- 浮动提示
- 叠加型微交互 UI

### 4.2 Widget API

```ts
export interface UiWidgetMountContext {
  pluginId: string;
  widgetId: string;
  slot: UiWidgetSlot;
  getActiveSessionId(): string | undefined;
  isActiveSession(sessionId?: string): boolean;
}

export type UiWidgetCleanup = () => void | Promise<void>;

export interface UiWidgetDefinition {
  id: string;
  slot: UiWidgetSlot;
  order?: number;
  mount(
    container: HTMLElement,
    context: UiWidgetMountContext,
  ): void | UiWidgetCleanup | Promise<void | UiWidgetCleanup>;
}
```

### 4.3 对外 Panel UI 插件 API

```ts
export interface PanelUiPluginApi {
  on(...): void;
  registerWidget(definition: UiWidgetDefinition): void;
}
```

---

## 5. 生命周期设计

### 5.1 hydrate / enable

1. 宿主读取 UI extension descriptor
2. `PanelUiPluginRuntime.enable(pluginId)` 执行插件 `ui.js`
3. 收集：
   - `handlers`
   - `widgets`
4. 如果对应 slot 已挂载，则立即 mount widget

### 5.2 disable

1. unmount 该插件的 widget
2. 执行 cleanup
3. 清除 widget / handler / remote cache

### 5.3 unregister

1. unmount 该插件的 widget
2. 执行 cleanup
3. 从 runtime state 中删除该插件

### 5.4 panel unmount

1. unmount 全部 widget
2. 逐个 cleanup
3. 清空 host slot 注册表

---

## 6. runtime 内部数据结构

### 6.1 扩展 `UiPluginState`

```ts
interface UiPluginState {
  descriptor: UiExtensionDescriptor;
  enabled: boolean;
  handlers: UiHandlerEntry[];
  widgets: UiWidgetDefinition[];
  remoteHookCache: Set<string> | null;
  errorCount: number;
  lastError?: string;
}
```

### 6.2 宿主侧挂载实例

```ts
interface MountedUiWidgetInstance {
  instanceId: string;
  pluginId: string;
  widgetId: string;
  slot: UiWidgetSlot;
  order: number;
  container: HTMLElement;
  cleanup?: UiWidgetCleanup;
}
```

---

## 7. mission-hud-dog 的迁移方式

### 7.1 保留的部分

`index.js` 保持不变：

- 继续监听 Agent hook
- 继续发送 `bbloop.ui.mascot`

### 7.2 迁移的部分

`ui.js` 改为：

- 使用 `ui.registerWidget(...)`
- 自己挂 DOM
- 自己监听 `chrome.runtime.onMessage`
- 只消费 `bbloop.ui.mascot`
- 按 active session 过滤
- 自己在 cleanup 里 removeListener + remove DOM

### 7.3 删除的宿主逻辑

从宿主删除：

- `MissionMascot.vue`
- `App.vue` 里的 `missionMascot` state
- `bbloop.ui.mascot` 的宿主硬编码处理

---

## 8. 文件改动清单

### 8.1 核心必改

- `extension/src/panel/utils/ui-plugin-runtime.ts`
  - 新增 widget 类型与 mount 生命周期
- `extension/src/panel/App.vue`
  - 新增 `chat.scene.overlay` host slot
  - 删除硬编码 mascot 链路
- `extension/plugins/example-mission-hud-dog/ui.js`
  - 改为真实插件自带 UI

### 8.2 应删除

- `extension/src/panel/components/MissionMascot.vue`

### 8.3 测试补充

- `extension/src/panel/utils/__tests__/ui-plugin-runtime.browser.test.ts`
  - 新增 widget mount / cleanup 用例
- `extension/src/panel/utils/__tests__/fixtures/ui-widget-plugin.ts`
  - 新增测试 fixture

---

## 9. 验收标准

### 9.1 行为验收

1. `mission-hud-dog` 启用后，狗 UI 正常显示
2. `mission-hud-dog` 禁用后，狗 UI 不再显示
3. `mission-hud-dog` 卸载后，狗 UI 不再显示且 DOM 被清理
4. 宿主里不再保留写死的 mascot 渲染逻辑

### 9.2 工程验收

1. extension 构建通过
2. extension 测试通过
3. 新增 widget runtime 测试覆盖 mount / cleanup 生命周期

---

## 10. 风险与约束

### 10.1 本轮已知约束

当前方案只解决 **Panel 侧插件自带 UI**。

它暂时不解决：

- `Plugin Studio` 的 `mem:// ui.js` 真正在 Panel 上下文执行
- 网页内容注入增强
- 网页内浮层 UI / DOM 替换 / 翻译替换

### 10.2 后续演进方向

后续可继续拆成两条：

1. **Panel Widget Extension**
   - 继续扩展 slot / widget API
2. **Page Enhancement Extension**
   - 面向网页注入、增强和 agent 场景脚本

二者应保持能力边界分离，避免混成一套 API。

---

## 11. 当前实施状态

当前按本计划推进，优先完成：

- widget runtime 底座
- overlay slot
- mission-hud-dog 迁移
- 测试与验证

后续若继续扩大范围，应先单独设计 `Plugin Studio mem UI` 与 `Page Enhancement` 方案，而不是直接叠加到本轮实现中。
