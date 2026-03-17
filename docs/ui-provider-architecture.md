# UI Provider 架构重构设计

> 日期：2026-03-19  
> 目标：将 SidePanel UI 侧的 LLM 配置从"单体 Profile"重构为"Provider + Profile 分离"架构，对齐 kernel 侧 Phase 1 实现。  
> 参考：`docs/llm-provider-subagent-design.md`、`~/work/repos/_research/pi-mono/packages/ai/`

## 0. 重构动机

### 现状问题

1. **数据结构混乱**：`PanelLlmProfile` 把 Provider 配置（apiBase/apiKey）和模型选择（llmModel）混在一起
2. **配置冗余**：每个 Profile 都存储 apiBase/apiKey，无法复用
3. **缺少动态发现**：无法从 Provider 动态获取支持的模型列表
4. **UI 语义不清**：用户配置时混淆"接入方式"和"具体模型"

### 架构对齐需求

Kernel 侧已在 Phase 1 完成：
- ✅ `LlmProviderAdapter` 接口
- ✅ `LlmProviderRegistry` 注册表
- ✅ `LlmResolvedRoute` 路由解析
- ✅ `llm-profile-resolver.ts` Profile -> Route 转换

UI 侧需要补齐：
- 🔄 Provider 管理 UI（添加/编辑/删除/测试）
- 🔄 Profile 引用 Provider（而非内嵌配置）
- 🔄 模型选择动态加载（基于 Provider）

## 1. 设计原则

### 1.1 分层架构

```
┌─────────────────────────────────────────────┐
│  UI Layer (SidePanel)                       │
│  - Provider 管理界面                        │
│  - Profile 配置界面                         │
│  - 模型选择下拉框（动态加载）               │
└─────────────────────────────────────────────┘
           │
           │ 引用
           ▼
┌─────────────────────────────────────────────┐
│  Kernel Layer (Service Worker)              │
│  - LlmProviderRegistry                      │
│  - LlmProviderAdapter                       │
│  - LlmResolvedRoute                         │
└─────────────────────────────────────────────┘
```

### 1.2 数据流向

1. **UI 侧**：用户配置 `PanelLlmProvider` + `PanelLlmProfile`
2. **持久化**：IndexedDB 存储（`config-store.ts`）
3. **运行时**：Bridge Config 传递给 Kernel
4. **解析**：`llm-profile-resolver.ts` 解析为 `LlmResolvedRoute`
5. **执行**：`LlmProviderRegistry` 路由到对应 Adapter

### 1.3 向后兼容

- 保留现有 `PanelLlmProfile` 字段的读取兼容性
- 提供迁移工具将旧配置转换为新结构
- UI 侧支持新旧格式共存（自动迁移）

## 2. 数据结构设计

### 2.1 PanelLlmProvider（新增）

```typescript
interface PanelLlmProvider {
  /** 唯一标识符，如 "openai_compatible"、"anthropic"、"cursor_help_web" */
  id: string;
  
  /** 显示名称，如 "通用 API"、"Anthropic Claude"、"Cursor 宿主聊天" */
  name: string;
  
  /** Provider 类型：
   * - "model_llm": 需要 apiBase/apiKey 的标准 LLM Provider
   * - "hosted_chat": 宿主聊天（如 Cursor Help Web），不需要 apiBase/apiKey
   */
  type: "model_llm" | "hosted_chat";
  
  /** API 配置（仅 model_llm 类型需要） */
  apiConfig?: {
    /** API 基础地址，如 "https://api.openai.com/v1" */
    apiBase: string;
    /** API Key（加密存储） */
    apiKey: string;
    /** 默认模型 ID（可选，用于快速选择） */
    defaultModel?: string;
    /** 支持的模型列表（可选，用于下拉框） */
    supportedModels?: string[];
    /** 是否支持动态获取模型列表 */
    supportsModelDiscovery?: boolean;
  };
  
  /** Provider 特定选项（可选） */
  options?: Record<string, unknown>;
  
  /** 是否内置 Provider（内置的不允许删除） */
  builtin: boolean;
}
```

### 2.2 PanelLlmProfile（重构）

```typescript
interface PanelLlmProfile {
  /** 唯一标识符，如 "default"、"worker-pro"、"scout-fast" */
  id: string;
  
  /** 引用 Provider ID（而非内嵌 apiBase/apiKey） */
  providerId: string;
  
  /** 模型 ID（从 Provider 的 supportedModels 中选择） */
  modelId: string;
  
  /** 角色（worker/scout/reviewer 等） */
  role?: string;
  
  /** 超时配置（ms） */
  timeoutMs: number;
  
  /** 最大重试次数 */
  retryMaxAttempts: number;
  
  /** 最大重试延迟（ms） */
  maxRetryDelayMs: number;
  
  /** 升级策略（disabled / upgrade_only） */
  escalationPolicy?: "disabled" | "upgrade_only";
  
  /** 升级链（Ordered profile IDs） */
  escalationChain?: string[];
  
  /** Profile 特定选项（可选） */
  options?: Record<string, unknown>;
}
```

### 2.3 迁移映射（旧 -> 新）

```typescript
// 旧格式
interface OldPanelLlmProfile {
  id: string;
  provider: string;        // 实际是 providerId
  llmApiBase: string;      // 移到 Provider.apiConfig.apiBase
  llmApiKey: string;       // 移到 Provider.apiConfig.apiKey
  llmModel: string;        // 改为 modelId
  providerOptions?: Record<string, unknown>;
  llmTimeoutMs: number;
  llmRetryMaxAttempts: number;
  llmMaxRetryDelayMs: number;
}

// 迁移逻辑
function migrateProfile(old: OldPanelLlmProfile): {
  provider: PanelLlmProvider;
  profile: PanelLlmProfile;
} {
  // 1. 提取 Provider 配置
  const provider: PanelLlmProvider = {
    id: old.provider,
    name: getProviderName(old.provider),
    type: old.provider === "cursor_help_web" ? "hosted_chat" : "model_llm",
    apiConfig: old.provider !== "cursor_help_web" ? {
      apiBase: old.llmApiBase,
      apiKey: old.llmApiKey,
      defaultModel: old.llmModel,
    } : undefined,
    builtin: false, // 旧配置视为用户自定义
  };
  
  // 2. 创建新 Profile
  const profile: PanelLlmProfile = {
    id: old.id,
    providerId: old.provider,
    modelId: old.llmModel,
    timeoutMs: old.llmTimeoutMs,
    retryMaxAttempts: old.llmRetryMaxAttempts,
    maxRetryDelayMs: old.llmMaxRetryDelayMs,
    options: old.providerOptions,
  };
  
  return { provider, profile };
}
```

## 3. UI 组件设计

### 3.1 Provider 管理视图（新增）

**文件**: `extension/src/panel/components/ProviderManagementView.vue`

**功能**:
- 列出所有 Provider（内置 + 自定义）
- 添加新 Provider（选择类型：通用 API / 预置集成）
- 编辑 Provider 配置（apiBase/apiKey/选项）
- 测试连接（发送测试请求验证配置）
- 删除自定义 Provider（内置的不允许删除）

**UI 布局**:
```
┌─────────────────────────────────────────┐
│ LLM Provider 管理                       │
├─────────────────────────────────────────┤
│ [+ 添加 Provider]                       │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ 🔌 通用 API (openai_compatible)     │ │
│ │    https://api.openai.com/v1        │ │
│ │    [编辑] [测试]                    │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ 🤖 Cursor 宿主聊天 (cursor_help)    │ │
│ │    已连接                           │ │
│ │    [编辑] [重新连接]                │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 3.2 Profile 配置视图（重构）

**文件**: `extension/src/panel/components/ProviderSettingsView.vue` (重构)

**功能**:
- 列出所有 Profile
- 添加新 Profile（选择 Provider -> 选择模型）
- 编辑 Profile（role/timeout/retry/escalation）
- 设置默认 Profile / 辅助 Profile / 降级 Profile

**UI 布局**:
```
┌─────────────────────────────────────────┐
│ LLM Profile 配置                        │
├─────────────────────────────────────────┤
│ [+ 添加 Profile]                        │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ ⭐ 默认配置 (default)               │ │
│ │    Provider: 通用 API               │ │
│ │    模型：GPT-5.4                    │ │
│ │    角色：worker                     │ │
│ │    [编辑] [设为默认]                │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ 🔍 快速探索 (scout-fast)            │ │
│ │    Provider: 通用 API               │ │
│ │    模型：GPT-5.3-codex              │ │
│ │    角色：scout                      │ │
│ │    [编辑]                           │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 3.3 模型选择器（新增组件）

**文件**: `extension/src/panel/components/ModelSelector.vue`

**功能**:
- 根据选中的 Provider 动态加载模型列表
- 支持手动输入（当 Provider 不支持动态发现时）
- 显示推荐模型标记

**Props**:
```typescript
interface ModelSelectorProps {
  providerId: string;
  modelId: string;
  onUpdateModelId: (modelId: string) => void;
}
```

## 4. Store 设计

### 4.1 Config Store 改造

**文件**: `extension/src/panel/stores/config-store.ts`

**改动**:
```typescript
// 新增
interface PanelConfig {
  // ... 现有字段 ...
  llmProviders: PanelLlmProvider[];  // 新增 Provider 列表
  llmProfiles: PanelLlmProfile[];    // 改造为引用 providerId
}

// 迁移工具
export function migrateLegacyConfig(
  raw: Record<string, unknown>
): PanelConfig {
  // 1. 提取旧 Profile 中的 Provider 配置
  // 2. 创建 PanelLlmProvider[]
  // 3. 转换为 PanelLlmProfile[]
  // 4. 返回新结构
}
```

### 4.2 Provider Registry Store（新增）

**文件**: `extension/src/panel/stores/provider-registry.ts`

**功能**:
- 管理 Provider 的添加/编辑/删除
- 测试 Provider 连接
- 动态发现模型列表（如果 Provider 支持）

```typescript
import { defineStore } from "pinia";

export const useProviderRegistryStore = defineStore("provider-registry", {
  state: () => ({
    providers: [] as PanelLlmProvider[],
    testingProvider: null as string | null,
    discoveredModels: {} as Record<string, string[]>,
  }),
  
  actions: {
    async addProvider(provider: PanelLlmProvider): Promise<void> {
      // 添加 Provider
    },
    
    async updateProvider(id: string, patch: Partial<PanelLlmProvider>): Promise<void> {
      // 更新 Provider
    },
    
    async deleteProvider(id: string): Promise<void> {
      // 删除 Provider（检查是否有 Profile 引用）
    },
    
    async testProvider(provider: PanelLlmProvider): Promise<{ ok: boolean; error?: string }> {
      // 发送测试请求
    },
    
    async discoverModels(providerId: string): Promise<string[]> {
      // 动态获取模型列表
    },
  },
});
```

## 4.3 Bridge Config 转换层（关键）

**问题**：Kernel 侧的 `BridgeConfig` 仍然使用旧格式（`llmProfiles` 包含 apiBase/apiKey），需要转换层。

**方案 A：UI 侧转换（推荐）**

在发送配置到 Bridge 之前，将新格式转换为旧格式：

```typescript
// extension/src/panel/utils/config-bridge-adapter.ts

interface LegacyBridgeConfig {
  // ... 其他字段 ...
  llmProfiles: Array<{
    id: string;
    provider: string;
    llmApiBase: string;
    llmApiKey: string;
    llmModel: string;
    providerOptions?: Record<string, unknown>;
    llmTimeoutMs: number;
    llmRetryMaxAttempts: number;
    llmMaxRetryDelayMs: number;
  }>;
}

export function convertToLegacyBridgeConfig(
  providers: PanelLlmProvider[],
  profiles: PanelLlmProfile[],
): LegacyBridgeConfig {
  // 1. 将 Profile + Provider 合并为旧格式
  const legacyProfiles = profiles.map((profile) => {
    const provider = providers.find((p) => p.id === profile.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${profile.providerId}`);
    }
    
    return {
      id: profile.id,
      provider: profile.providerId,
      llmApiBase: provider.apiConfig?.apiBase || "",
      llmApiKey: provider.apiConfig?.apiKey || "",
      llmModel: profile.modelId,
      providerOptions: {
        ...provider.options,
        ...profile.options,
      },
      llmTimeoutMs: profile.timeoutMs,
      llmRetryMaxAttempts: profile.retryMaxAttempts,
      llmMaxRetryDelayMs: profile.maxRetryDelayMs,
    };
  });
  
  return {
    // ... 其他字段从 config store 读取 ...
    llmProfiles: legacyProfiles,
  };
}
```

**优点**：
- ✅ Kernel 侧无需改动（`llm-profile-resolver.ts` 继续工作）
- ✅ Bridge 协议无需改动
- ✅ 渐进式重构（先 UI 侧，后 Kernel 侧）

**方案 B：Kernel 侧支持新格式（长期目标）**

修改 `BridgeConfig` 和 `llm-profile-resolver.ts` 支持新格式：

```typescript
// extension/src/sw/kernel/infra-bridge-client.ts

export interface BridgeConfig {
  // ... 现有字段 ...
  llmProviders?: unknown;  // 新增
  llmProfiles?: unknown;   // 改为引用 providerId
}

// extension/src/sw/kernel/llm-profile-resolver.ts

export function resolveLlmRoute(
  input: ResolveLlmRouteInput,
): ResolveLlmRouteResult {
  const { config } = input;
  
  // 1. 优先尝试新格式（llmProviders + llmProfiles）
  if (config.llmProviders && Array.isArray(config.llmProviders)) {
    return resolveLlmRouteNewFormat(config);
  }
  
  // 2. 回退到旧格式（向后兼容）
  return resolveLlmRouteLegacyFormat(config);
}
```

**优点**：
- ✅ 架构统一（UI + Kernel 使用相同数据结构）
- ✅ 减少转换开销

**缺点**：
- 🔄 需要改动 Kernel 侧代码
- 🔄 需要确保向后兼容

**推荐实施顺序**：
1. Phase 1-3：使用方案 A（UI 侧转换）
2. Phase 5：评估是否迁移到方案 B（Kernel 侧支持）
3. Phase 6：完成方案 B 迁移（可选）

## 4.4 API Key 加密存储（安全要求）

**问题**：API Key 不能明文存储在 IndexedDB 中。

**方案**：使用 Chrome 扩展的 `chrome.storage.session` + 内存加密。

```typescript
// extension/src/panel/utils/crypto-utils.ts

const API_KEY_STORAGE_KEY = "provider_api_keys";

// 加密存储 API Key
export async function encryptAndStoreApiKey(
  providerId: string,
  apiKey: string,
): Promise<void> {
  // 1. 使用 Web Crypto API 加密
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );
  
  // 2. 存储到 chrome.storage.session（内存，扩展卸载后清除）
  const storage = await chrome.storage.session.get(API_KEY_STORAGE_KEY);
  const keys = storage[API_KEY_STORAGE_KEY] || {};
  keys[providerId] = {
    ciphertext: Array.from(new Uint8Array(ciphertext)),
    iv: Array.from(iv),
  };
  await chrome.storage.session.set({ [API_KEY_STORAGE_KEY]: keys });
}

// 解密读取 API Key
export async function decryptApiKey(providerId: string): Promise<string | null> {
  const storage = await chrome.storage.session.get(API_KEY_STORAGE_KEY);
  const keys = storage[API_KEY_STORAGE_KEY] || {};
  const encrypted = keys[providerId];
  if (!encrypted) return null;
  
  const key = await getEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(encrypted.iv) },
    key,
    new Uint8Array(encrypted.ciphertext),
  );
  
  return new TextDecoder().decode(plaintext);
}

// 派生加密密钥（基于用户设备指纹）
async function getEncryptionKey(): Promise<CryptoKey> {
  // 使用 Web Crypto API 派生密钥
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(window.location.origin + navigator.userAgent),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("browser-brain-loop-salt"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
```

**Store 集成**：

```typescript
// extension/src/panel/stores/provider-registry.ts

export const useProviderRegistryStore = defineStore("provider-registry", {
  actions: {
    async addProvider(provider: PanelLlmProvider): Promise<void> {
      // 1. 加密存储 API Key
      if (provider.apiConfig?.apiKey) {
        await encryptAndStoreApiKey(provider.id, provider.apiConfig.apiKey);
        // 2. 从对象中移除明文
        provider.apiConfig = {
          ...provider.apiConfig,
          apiKey: "", // 占位，实际值在加密存储中
        };
      }
      
      // 3. 存储 Provider 配置（不含明文 API Key）
      this.providers.push(provider);
      await saveProvidersToIndexedDB(this.providers);
    },
    
    async getProviderWithApiKey(providerId: string): Promise<PanelLlmProvider | null> {
      const provider = this.providers.find((p) => p.id === providerId);
      if (!provider) return null;
      
      // 从加密存储中读取 API Key
      const decryptedKey = await decryptApiKey(providerId);
      if (decryptedKey) {
        return {
          ...provider,
          apiConfig: {
            ...provider.apiConfig,
            apiKey: decryptedKey,
          },
        };
      }
      
      return provider;
    },
  },
});
```

**安全特性**：
- ✅ API Key 加密存储（AES-GCM）
- ✅ 使用 `chrome.storage.session`（内存，扩展卸载后清除）
- ✅ 密钥派生基于设备指纹（PBKDF2）
- ✅ 不在 IndexedDB 中存储明文

**注意事项**：
- 🔒 扩展重启后需要用户重新输入 API Key（安全特性，不是 bug）
- 🔒 不提供"记住 API Key"选项（防止泄露）
- 🔒 日志中不打印 API Key（脱敏处理）

## 5. 迁移策略

### 5.1 自动迁移（推荐）

**触发时机**: 首次加载配置时检测旧格式

**迁移逻辑**:
```typescript
function detectAndMigrate(raw: unknown): PanelConfig {
  // 检测是否为旧格式
  if (isLegacyFormat(raw)) {
    // 执行迁移
    const migrated = migrateLegacyConfig(raw);
    // 保存到 IndexedDB
    await saveConfig(migrated);
    // 通知用户
    notifyUser("配置已自动迁移到新格式");
    return migrated;
  }
  return normalizeConfig(raw);
}
```

### 5.2 手动迁移工具

**文件**: `extension/src/panel/utils/migrate-config.ts`

**功能**:
- 导出旧配置
- 转换为新格式
- 导入并验证

### 5.3 回滚方案

保留旧格式的读取兼容性，如果新格式出现问题可以回滚：

```typescript
function normalizeConfig(raw: unknown): PanelConfig {
  // 优先尝试新格式
  if (isNewFormat(raw)) {
    return normalizeNewFormat(raw);
  }
  // 回退到旧格式
  return migrateLegacyConfig(raw);
}
```

## 6. 实施步骤

### Phase 1: 数据结构（1-2 天）

- [ ] 定义 `PanelLlmProvider` 接口
- [ ] 改造 `PanelLlmProfile` 接口
- [ ] 实现迁移工具 `migrateLegacyConfig`
- [ ] 更新 `config-store.ts` 类型定义
- [ ] 编写单元测试

### Phase 2: Provider Registry（2-3 天）

- [ ] 实现 `provider-registry.ts` Store
- [ ] 创建 `ProviderManagementView.vue` 组件
- [ ] 实现 Provider 测试连接功能
- [ ] 实现模型动态发现（如果 Provider 支持）
- [ ] 编写集成测试

### Phase 3: Profile 重构（2-3 天）

- [ ] 重构 `ProviderSettingsView.vue`
- [ ] 创建 `ModelSelector.vue` 组件
- [ ] 实现 Profile 编辑器
- [ ] 实现升级链配置 UI
- [ ] 编写 E2E 测试

### Phase 4: 迁移与兼容（1-2 天）

- [ ] 实现自动迁移逻辑
- [ ] 添加手动迁移工具
- [ ] 测试旧配置兼容性
- [ ] 编写迁移文档
- [ ] 用户通知机制

### Phase 5: 观测与优化（1-2 天）

- [ ] 添加 Provider 使用统计
- [ ] 实现模型推荐（基于使用频率）
- [ ] 优化 UI/UX
- [ ] 性能优化（缓存模型列表）

## 7. 测试策略

### 7.1 单元测试

- `config-store.test.ts`: 配置归一化 + 迁移逻辑
- `provider-registry.test.ts`: Provider CRUD + 测试连接
- `migrate-config.test.ts`: 旧格式 -> 新格式转换

### 7.2 集成测试

- Provider 添加 -> Profile 引用 -> LLM 调用全链路
- 模型动态发现 -> 下拉框渲染 -> 用户选择
- 升级链配置 -> 触发升级 -> 事件上报

### 7.3 E2E 测试

- 用户添加新 Provider
- 用户创建新 Profile
- 用户配置升级链
- 旧配置自动迁移

## 8. 风险与缓解

### 风险 1: 迁移丢失数据

**缓解**:
- 迁移前备份旧配置
- 保留旧格式读取兼容性
- 提供手动回滚工具

### 风险 2: UI 复杂度增加

**缓解**:
- 分阶段上线（先 Provider 管理，后 Profile 重构）
- 提供默认配置（用户无需手动配置）
- 优化 UI 文案和引导

### 风险 3: 性能问题（动态发现模型）

**缓解**:
- 缓存模型列表（IndexedDB）
- 按需加载（打开下拉框时才请求）
- 超时控制（5 秒无响应则降级为手动输入）

## 9. 对齐检查清单

### pi-mono 对齐

- [ ] Provider 双层架构（Adapter + Registry）
- [ ] Profile 引用 Provider（而非内嵌配置）
- [ ] 模型动态发现（如果 Provider 支持）
- [ ] 升级链配置（显式声明）

### BBL Kernel 对齐

- [ ] `LlmProviderAdapter` 接口一致
- [ ] `LlmProviderRegistry` 注册表一致
- [ ] `LlmResolvedRoute` 结构一致
- [ ] `llm-profile-resolver.ts` 逻辑一致

### 向后兼容

- [ ] 旧配置自动迁移
- [ ] 旧格式读取兼容
- [ ] 迁移工具可回滚

## 10. 验收标准

### 功能验收

1. ✅ 用户可以添加/编辑/删除 Provider
2. ✅ 用户可以创建 Profile 并选择 Provider + 模型
3. ✅ 旧配置自动迁移且数据完整
4. ✅ 升级链配置生效且可观测
5. ✅ 模型动态发现（如果 Provider 支持）

### 质量验收

1. ✅ 单元测试覆盖率 > 80%
2. ✅ E2E 测试全通过
3. ✅ 无 TypeScript 类型错误
4. ✅ UI 无障碍（ARIA + 键盘导航）
5. ✅ 性能指标（模型列表加载 < 2 秒）

### 文档验收

1. ✅ 更新 `docs/kernel-architecture.md`
2. ✅ 创建 `docs/ui-provider-architecture.md`（本文档）
3. ✅ 更新 `extension/README.md`
4. ✅ 编写用户迁移指南

## 11. 后续工作

### Phase 6: 高级功能

- [ ] Provider 使用统计（调用次数/成功率/延迟）
- [ ] 模型推荐（基于任务类型）
- [ ] 自动测试（定期验证 Provider 可用性）
- [ ] Provider 市场（一键安装预置 Provider）

### Phase 7: Agents 编排

- [ ] 角色绑定 Profile（scout/worker/reviewer）
- [ ] 子任务编排（single/parallel/chain）
- [ ] 生命周期管理（取消/重试预算）
- [ ] 细粒度观测与回填策略

## 12. 参考资料

- `docs/llm-provider-subagent-design.md` - Phase 1/2 设计文档
- `extension/src/sw/kernel/llm-provider.ts` - Kernel Provider 接口
- `extension/src/sw/kernel/llm-provider-registry.ts` - Kernel Registry 实现
- `extension/src/sw/kernel/llm-profile-resolver.ts` - Profile 解析器
- `~/work/repos/_research/pi-mono/packages/ai/` - pi-mono Provider 参考
