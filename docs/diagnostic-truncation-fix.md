# 诊断系统截断问题修复方案

## 问题现状

### 当前诊断限制
1. **stepStream 上限**: 5000 个事件 / 4MB
2. **decisionTrace 上限**: 最后 80 个事件
3. **timeline 上限**: 最后 24 行
4. **llm.trace 上限**: 120 个事件
5. **tool.trace 上限**: 140 个事件

### 用户痛点
- **长会话诊断不完整**: 当会话执行超过 80 步时，早期步骤丢失
- **LLM 调用历史丢失**: 35 轮 LLM 调用只保留最后 2 轮
- **难以定位根因**: 无法看到完整的执行轨迹

## 根本原因分析

### 设计初衷（合理）
- 防止诊断文件过大（浏览器内存限制）
- 提高诊断导出速度
- 聚焦最近事件（大多数问题的根因在近期）

### 实际问题
- **长会话需求**: 复杂任务可能需要 100+ 步
- **调试需求**: 需要完整历史分析模式
- **统计误导**: `stepCount` 包含流式片段，造成"240 步"假象

## 修复方案

### 方案 A: 分层诊断（推荐）

**核心思想**: 保留完整统计 + 可配置的细节层级

```typescript
interface DiagnosticProfile {
  mode: "quick" | "standard" | "full";
  stepStreamLimit: number;      // 100 / 5000 / 20000
  decisionTraceLimit: number;   // 40 / 80 / 500
  timelineLimit: number;        // 12 / 24 / 100
  llmTraceLimit: number;        // 40 / 120 / 500
  toolTraceLimit: number;       // 60 / 140 / 500
}
```

**实现**:
1. 在 DebugView 添加诊断级别选择器（快速/标准/完整）
2. 根据级别动态调整 limit 参数
3. 完整模式下保留所有事件（受 5000/4MB 限制）

### 方案 B: 轮转诊断存储

**核心思想**: 在 IndexedDB 中保存多个诊断快照

```typescript
interface DiagnosticSnapshot {
  sessionId: string;
  sequenceNumber: number;  // 1, 2, 3...
  stepRange: [number, number];  // [1, 50], [51, 100]
  payload: JsonRecord;
  createdAt: string;
}
```

**实现**:
1. 每 50 步自动保存一个诊断快照到 IndexedDB
2. 导出时可选择"最近 50 步"或"完整历史"
3. 完整历史 = 合并所有快照

### 方案 C: 修复 stepCount 统计

**问题**: 当前把流式文本片段也计入步数

```typescript
// 当前（错误）
stepCount: events.length  // 包含所有事件

// 修复（正确）
stepCount: events.filter(e => 
  e.type.startsWith("step_") || 
  e.type.startsWith("loop_")
).length
```

### 方案 D: 添加 stepRange 元信息

**问题**: 用户不知道诊断包含哪些步骤

```typescript
summary: {
  stepCount: events.length,
  stepRange: [firstStep, lastStep],  // 新增：[62, 71]
  llmRequestRange: [first, last],    // 新增：[34, 35]
  isTruncated: stepStreamMeta.truncated,
  truncationReason: "max_events" | "max_bytes" | null
}
```

## 推荐实施顺序

### Phase 1: 快速修复（1 天）
- ✅ 方案 C: 修复 stepCount 统计
- ✅ 方案 D: 添加 stepRange 元信息
- ✅ 在 UI 中显示"诊断包含步骤 X-Y"

### Phase 2: 分层诊断（2-3 天）
- 方案 A: 添加诊断级别选择器
- 支持"完整模式"导出所有事件
- UI 提示"完整模式可能需要更长时间"

### Phase 3: 轮转存储（3-5 天）
- 方案 B: IndexedDB 持久化
- 自动快照机制
- 合并导出功能

## 代码修改位置

### Phase 1 修改
1. `extension/src/panel/utils/diagnostics.ts`
   - 修改 `summary.stepCount` 统计逻辑
   - 添加 `summary.stepRange` 和 `summary.llmRequestRange`
   - 添加 `summary.isTruncated` 和 `truncationReason`

2. `extension/src/panel/components/DebugView.vue`
   - 显示步骤范围信息
   - 显示截断警告

### Phase 2 修改
3. `extension/src/panel/components/DebugView.vue`
   - 添加诊断级别选择器（下拉框）
   - 传递 `diagnosticProfile` 到 `collectDiagnostics`

4. `extension/src/panel/utils/diagnostics.ts`
   - 添加 `DiagnosticProfile` 类型
   - 修改 `collectDiagnostics` 接受 profile 参数
   - 动态调整各个 limit

### Phase 3 修改
5. `extension/src/sw/kernel/session-store.browser.ts`
   - 添加 IndexedDB 快照存储逻辑

6. `extension/src/panel/utils/diagnostics.ts`
   - 添加 `mergeDiagnosticSnapshots` 函数

## 预期效果

### 修复前
```
步骤计数：240 步  ❌（包含流式片段）
实际工具步骤：10 步（62-71）
LLM 调用：显示 2 次（实际 35 次）
```

### 修复后（Phase 1）
```
步骤计数：10 步（工具执行）✓
步骤范围：62-71 ✓
LLM 调用范围：34-35 ✓
诊断截断：是（最大 80 事件）✓
```

### 修复后（Phase 2）
```
诊断级别：[快速 ▼] [标准] [完整]
当前：标准模式（最后 80 步）
完整模式：所有 240 步（可能较慢）
```

## 技术风险

1. **内存风险**: 完整模式可能占用较多内存
   - 缓解：限制最大 20000 事件 / 16MB

2. **性能风险**: 导出时间变长
   - 缓解：异步导出 + 进度条

3. **兼容性风险**: 旧诊断格式不包含 stepRange
   - 缓解：可选字段，默认 undefined

## 用户价值

1. **透明度**: 清楚知道诊断包含哪些步骤
2. **可调试性**: 可以导出完整历史进行分析
3. **准确性**: stepCount 反映真实工具执行数
