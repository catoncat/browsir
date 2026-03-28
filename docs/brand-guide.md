# 白雪 Snowy — 品牌指南

> 最后更新：2026-03-28
> 本文档是 Agent 执行产品品牌化的 spec。所有 UI 文案改写、manifest 更新、新手引导开发以此为准。

---

## 1. 基础信息

| 项 | 内容 |
|---|---|
| **中文名** | 白雪 |
| **英文名** | Snowy |
| **全称** | 白雪 Snowy |
| **品类** | Chrome 扩展 · AI 浏览器助手 |
| **一句话** | 住在你浏览器里的 AI 伙伴 |
| **Slogan（中）** | 装上就能用的 AI 浏览器助手 |
| **Slogan（英）** | Your AI browser assistant. Install and go. |
| **品牌使命** | 让每个人都能用自然语言操控浏览器，不需要写代码、装软件、配环境。 |
| **品牌基调** | 双面型 — 入门友好，深度可玩 |
| **开源** | 完全开源（GitHub） |

### Tagline 变体

| 场景 | 中文 | English |
|------|------|---------|
| **Chrome Web Store 短描述**（≤132 字符） | 用自然语言操控网页的 AI 助手。填表、点击、提取数据、后台自动化——装上就能用，开源免费。 | AI browser assistant. Automate web tasks with natural language — forms, clicks, data extraction. Open source. |
| **社媒 bio** | 白雪 Snowy — 住在浏览器里的 AI 伙伴。说话就能操控网页。 | Snowy — your AI buddy in the browser. Talk to web pages. |
| **产品内空状态** | 我是白雪，你的浏览器 AI 助手。告诉我你想做什么。 | I'm Snowy, your browser AI assistant. Tell me what you'd like to do. |

### 品牌名使用规范

| 场景 | 写法 | 示例 |
|------|------|------|
| 中文正式场合 | 白雪 | "白雪可以帮你自动填表" |
| 英文正式场合 | Snowy | "Snowy can automate form filling" |
| 首次出现 / 标题 / 商店名 | 白雪 Snowy | Chrome Web Store 扩展名 |
| 代码内部 / 日志 | `snowy` 或 `bbl`（内部缩写） | `[snowy] pollUpdates started` |

**禁止**：任何用户可见位置出现 "Browser Brain Loop"、"Agent Terminal"、"BBL"。

---

## 2. 品牌定位

### 定位声明（中文）

对于**需要在浏览器里重复操作但不会写代码的人**，白雪是一个**Chrome 扩展 AI 助手**，让你用**说话的方式操控网页**。跟需要安装本地软件或学编程的自动化工具不同，白雪装上就能用，数据留在浏览器里，代码完全开源。

### Positioning Statement (English)

For **people who repeat browser tasks but don't code**, Snowy is a **Chrome extension AI assistant** that lets you **control web pages with natural language**. Unlike automation tools that require local software or programming, Snowy works instantly after install, keeps data in your browser, and is fully open source.

---

## 3. 目标用户画像

### A. 重复操作知识工作者

| 维度 | 内容 |
|------|------|
| **谁** | 行政、运营、HR、财务、客服——每天在浏览器里重复填表、搬数据、管标签页 |
| **痛点** | 重复操作耗时但不值得找开发做自动化；用 RPA 工具太复杂 |
| **白雪怎么解** | 用自然语言说"帮我把这个表填了"，白雪直接操作网页 |
| **入口层** | ★ 入门（填表、点击、导航、截图） |
| **深度触发** | 发现可以创建技能复用 → 进入 ★★★★ 扩展层 |

### B. 开发者 / 技术用户

| 维度 | 内容 |
|------|------|
| **谁** | 前端/全栈开发者，需要浏览器自动化但不想配 Playwright/Puppeteer 环境 |
| **痛点** | 每个项目都要装一堆依赖；测试和调试分离；没有好用的浏览器内 Shell |
| **白雪怎么解** | 浏览器里直接有 Linux 沙盒、虚拟文件系统、Bridge 连本地机器 |
| **入口层** | ★★ 进阶（浏览器沙盒 Shell）或 ★★★ 高级（Bridge 连接） |
| **深度触发** | 发现 Plugin 系统（17 Hook 点）和 MCP 协议 → 在浏览器里构建完整工具链 |

### C. 微信生态用户

| 维度 | 内容 |
|------|------|
| **谁** | 重度微信用户，习惯在微信里完成一切，不想切换应用 |
| **痛点** | AI 工具都要开单独的 App 或网页；想在微信里直接用 |
| **白雪怎么解** | 通过微信消息指挥白雪完成浏览器任务，回复直接发到微信 |
| **入口层** | 微信渠道（零配置，扫码即连） |
| **深度触发** | 发现白雪能做的不只是聊天，而是真的能操控网页 → 打开 SidePanel 探索更多 |

---

## 4. 名字由来

"白雪"取自丁丁历险记（The Adventures of Tintin）中的小狗 Snowy（法语名 Milou）。它忠诚、机灵，跟着主人到处冒险。

> 品牌视觉致敬丁丁历险记但不使用原作图像，避免 IP 风险。

### 品牌特质 → 产品决策原则

这三个特质不只是文案修辞，而是 Agent 做功能取舍时的判断依据：

| 特质 | 品牌含义 | 产品决策原则 |
|------|---------|-------------|
| **忠诚** | 始终在你的浏览器里待命 | 本地优先：数据存 IndexedDB 不出浏览器；完全开源可审计；不做数据上传；离线能力优先 |
| **机灵** | 能理解页面、操作元素、帮你做事 | 上下文感知：主动理解当前页面状态；渐进式揭示能力（不一上来就暴露所有功能）；智能降级而非报错 |
| **冒险伙伴** | 陪你一起浏览、操作、解决问题 | 跟随用户成长：能力分层（入门→扩展）；从简单任务引导到复杂场景；永远是协助者不是替代者 |

---

## 5. 能力分层

```
┌─────────────────────────────────────────────┐
│  白雪 Snowy                                 │
├─────────────────────────────────────────────┤
│                                             │
│  ★ 入门 — 装上就能用                         │
│    · 说话操控网页：填表、点击、导航            │
│    · 多标签页管理                            │
│    · 页面内容提取和截图                       │
│                                             │
│  ★★ 进阶 — 浏览器里就有 Linux                │
│    · 内置浏览器沙盒 Shell（60+ 命令）         │
│    · 虚拟文件系统（mem://）                   │
│    · 不依赖任何本地环境                       │
│                                             │
│  ★★★ 高级 — 连接你的电脑                     │
│    · 通过 Bridge 操作宿主机文件和命令          │
│    · SSH 隧道连接远程机器                     │
│    · 本地 + 远程，一个入口搞定                │
│                                             │
│  ★★★★ 扩展 — 能力无限生长                   │
│    · 技能系统：一句话创建可复用技能            │
│    · 插件系统：5 类扩展 + 17 Hook            │
│    · MCP 协议支持                            │
│                                             │
└─────────────────────────────────────────────┘
```

### 每层用户场景

| 层级 | 用户说 | 白雪做 |
|------|--------|--------|
| ★ 入门 | "帮我把这个表格填了" | 识别表单字段，逐项填写，点击提交 |
| ★ 入门 | "把这个页面的价格表截图发给我" | 定位表格区域，截图，返回图片 |
| ★ 入门 | "关掉所有淘宝的标签页" | 列出所有标签，匹配 URL，批量关闭 |
| ★★ 进阶 | "把这个网页的数据整理成 CSV" | 提取页面数据，在沙盒 Shell 里用 awk/sed 处理，写入虚拟文件 |
| ★★ 进阶 | "帮我写个脚本分析这些数据" | 在浏览器沙盒里写代码、执行、返回结果 |
| ★★★ 高级 | "读取我桌面上的 Excel，填到这个网页表单里" | 通过 Bridge 读本地文件，解析内容，在浏览器里填表 |
| ★★★ 高级 | "把这个页面的数据存到我电脑上的 data.json" | 提取数据，通过 Bridge 写入本地文件系统 |
| ★★★★ 扩展 | "创建一个技能：每次打开京东自动比价" | 创建技能包，持久化到 IndexedDB，后续一句话调用 |

### 渐进发现策略

| 触发条件 | 引导动作 |
|----------|---------|
| 用户完成第一个网页操作任务 | 提示"你还可以让白雪帮你截图和提取页面内容" |
| 用户尝试处理数据 | 提示"白雪内置了 Linux 终端，可以直接在浏览器里处理数据" |
| 用户提到本地文件 | 提示"连接本地桥接后，白雪可以直接读写你电脑上的文件" |
| 用户重复执行类似任务 | 提示"要不要把这个操作保存成技能？以后一句话就能复用" |

---

## 6. 核心价值主张

### 消息层级

按沟通深度组织，不同场景取不同层级：

**30 秒（商店列表 / 电梯演讲）：**
1. **即装即用** — 纯 Chrome 扩展，零配置启动
2. **说话就干活** — 自然语言操控网页

**2 分钟（演示 / 社媒视频）：**
3. **浏览器就是终端** — 内置 Linux 沙盒，在浏览器里跑 Shell
4. **你的数据你做主** — 对话存本地、代码全开源、AI 调用是唯一云端通信

**深度（博文 / 教程 / 技术社区）：**
5. **连接你的电脑** — 通过 Bridge 操作本地和远程机器
6. **能力无限扩展** — 技能 / 插件 / MCP，想加什么加什么
7. **微信也能用** — 通过微信消息指挥白雪完成浏览器任务
8. **完全开源** — MIT 协议，代码在 GitHub，社区驱动

---

## 7. 术语命名系统

Agent 做 UI 文案时必须查这张表。用户侧只出现"中文面向用户"列的词。

| 内部术语 | 中文面向用户 | English 面向用户 | 禁用写法 | 备注 |
|----------|-------------|-----------------|---------|------|
| Skill | 技能 | Skill | 技巧、脚本 | |
| Plugin | 插件 | Plugin | 扩展（与 Chrome 扩展冲突） | |
| Session | 对话 | Conversation | 会话（太正式） | |
| Bridge | 本地桥接 | Local Bridge | 桥、WebSocket | ★ 入门用户不暴露此概念 |
| Channel | 渠道 | Channel | 通道 | |
| Tool | — | — | 工具 | 用户侧不出现，只说"帮你做 XX" |
| SidePanel | 侧边栏 | Side Panel | 面板 | |
| Sandbox / Shell | 终端 | Terminal | 沙盒（太技术） | |
| Virtual FS | 虚拟文件 | Virtual Files | VFS、mem:// | |
| Intervention | 人工确认 | Manual Confirmation | 干预 | |
| Automation Mode | 自动化模式 | Automation Mode | | Focus / Background 对用户说"前台/后台" |

### 命名规则

- 新功能命名用**动词/动作**（"帮你 XX"），不用技术名词
- 中文优先口语化，英文优先 casual
- 同一个概念在产品内只用一个词，不混用

---

## 8. 第一印象策略

定义安装后 30 秒的体验。Agent 实现新手引导时以此为 spec。

### SidePanel 标题

| 当前 | 改为 |
|------|------|
| "Agent Terminal" | "白雪"（中文环境）/ "Snowy"（英文环境），旁边放狗图标 |

### 空状态（无对话历史时）

**当前**：
```
[Activity 图标]
就绪。发送消息让 Agent 帮你完成浏览器任务。
```

**改为**：
```
[白雪狗图标]
我是白雪，你的浏览器 AI 助手。

[帮我总结这个页面]  [查看所有标签页]  [帮我截图]
```

- 三个建议操作为可点击按钮，点击后直接发送对应文本
- 建议操作不需要任何配置即可执行（不依赖 Bridge）
- 英文版：`I'm Snowy, your browser AI assistant.` + `[Summarize this page]` `[Show all tabs]` `[Take a screenshot]`

### 首次成功任务后

第一次任务完成后，在回复末尾追加一行轻提示（不是弹窗）：

```
💡 白雪还能帮你在浏览器里跑终端命令。试试"列出当前目录的文件"。
```

### Chat 输入框 Placeholder

| 当前 | 改为 |
|------|------|
| `/技能 @标签` | `告诉白雪你想做什么…`（中文）/ `Tell Snowy what to do…`（英文） |

---

## 9. 隐私与信任

### 三大信任支柱

| 支柱 | 中文表述 | English | 技术事实 |
|------|---------|---------|---------|
| **本地存储** | 对话留在浏览器，不上传任何服务器 | Conversations stay in your browser | IndexedDB 本地存储，无服务端 |
| **开源透明** | 代码完全开源，随时可审计 | Fully open source, audit anytime | GitHub 公开仓库，MIT 协议 |
| **最小云端** | 只有 AI 调用走云端，用你自己的 API Key | Only AI calls go to the cloud, using your own API key | LLM API 是唯一外部通信 |

### 场景文案模板

**Chrome Web Store 隐私声明：**
> 白雪不收集、不上传、不存储你的任何数据。所有对话记录保存在浏览器本地（IndexedDB）。唯一的网络通信是你配置的 AI 模型 API 调用，使用你自己的 API Key。代码完全开源。

**设置页隐私提示（简短版）：**
> 🔒 你的数据只存在这台电脑的浏览器里。白雪是开源软件。

**首次运行提示（如果实现 onboarding）：**
> 白雪所有数据都留在你的浏览器里，不会上传到任何服务器。AI 模型调用使用你自己配置的 API Key。

### `host_permissions: <all_urls>` 的解释

用户或商店审核可能质疑此权限。统一话术：
> 白雪需要访问你指定的网页才能帮你操作——填表、点击、提取内容。白雪只在你主动发起任务时访问页面，不会在后台扫描或收集数据。

---

## 10. Tone of Voice

### 原则

**双面型** — 入门时亲切简洁，展示能力时专业可靠。

### 角色感

对话用户时，像一只聪明的小狗坐在你旁边等你下令——亲切但不谄媚，自信但不傲慢。

### 用词规范

| 做 ✅ | 不做 ❌ |
|-------|--------|
| "告诉白雪你想做什么" | "通过自然语言界面输入指令" |
| "帮你搞定" | "实现端到端的网页自动化" |
| "悄悄在后台帮你干活" | "基于 Service Worker 的后台执行引擎" |
| "装上就能用" | "零配置的轻量级部署方案" |
| "浏览器里的终端" | "基于 WebAssembly 的沙盒化 POSIX 环境" |
| "对话留在你电脑上" | "本地 IndexedDB 持久化存储" |

### 场景化语气指引

| 场景 | 语气 | 中文示例 | English |
|------|------|---------|---------|
| **成功** | 简洁确认，不过度庆祝 | "搞定了。" / "已经帮你填好了。" | "Done." / "Form filled." |
| **出错** | 坦诚 + 下一步 | "这一步没成功，我换个方式再试。" | "That didn't work. Let me try another way." |
| **等待中** | 拟人化，不用技术术语 | "白雪正在想…" / "处理中…" | "Snowy is thinking…" / "Working on it…" |
| **后台运行** | 低调存在感 | "白雪在后台帮你盯着呢。" | "Snowy is working in the background." |
| **微信回复** | 比 SidePanel 更口语 | "帮你查好了：……" | — |
| **能力边界** | 诚实，不编造 | "这个我暂时做不到，但你可以试试……" | "I can't do that yet, but you could try…" |

### 禁用模式

- ❌ 不用"亲"（淘宝客服体）
- ❌ 不用企业黑话（"赋能"、"抓手"、"闭环"）
- ❌ 不用假热情（"太棒了！！！"、"恭喜恭喜！"）
- ❌ 不堆 emoji（最多偶尔一个 💡 或 🔒 用于提示类信息）
- ❌ 不自称"我们"（白雪是一只狗，用"我"或"白雪"）

---

## 11. 视觉方向

### 现有资产

| 资产 | 描述 | 位置 |
|------|------|------|
| **主图标** | 白色梗犬剪影，橙色背景，红色领巾，圆角方形 | `extension/public/icon-master.png` |
| **尺寸变体** | 16×16、48×48、128×128 | `extension/public/icons/` |

### 色彩系统（从 CSS 提取）

| 用途 | Light Mode | Dark Mode |
|------|-----------|-----------|
| 背景 `--bg` | `#ffffff` | `#1e1f20` |
| 文字 `--text` | `#1a1a1b` | `#ffffff` |
| 次要文字 `--text-muted` | `#4d5156` | `#bdc1c6` |
| 边框 `--border` | `#e0e0e2` | `#3c4043` |
| 表面 `--surface` | `#f1f3f4` | `#2b2d2f` |
| 强调 `--accent` | `#1a73e8` | `#8ab4f8` |
| 深层背景 `--bg-darker` | `#f0f1f3` | `#161718` |

**品牌色（来自图标）：** 橙色 `#E8762D`（暂定，可用作次要强调色）

**字体：** Inter, system-ui, -apple-system, sans-serif

### Chrome Web Store 素材规格

| 素材 | 尺寸 | 内容规划 |
|------|------|---------|
| 扩展图标 | 128×128 | 现有狗图标 |
| Promo Tile (Small) | 440×280 | 图标 + "白雪 Snowy" + Slogan |
| Screenshot 1 | 1280×800 | 空状态欢迎界面 + 建议操作 |
| Screenshot 2 | 1280×800 | 自然语言操作网页的实际场景（填表） |
| Screenshot 3 | 1280×800 | 浏览器终端（Shell 执行命令） |
| Screenshot 4 | 1280×800 | 微信渠道连接 |
| Screenshot 5 | 1280×800 | 深色模式全景 |

---

## 12. 竞品差异化

### 核心差异

白雪的差异化不是单点优势，而是**组合独特性**：

> 零安装浏览器自动化 + 本地优先数据 + 完全开源 + 微信通道 + 技能/插件扩展 + 后台模式

这个组合目前没有任何竞品完全覆盖。

### 逐竞品对比

| 对比维度 | 白雪 Snowy | ChatGPT 浏览器扩展 | Claude Computer Use | Sider / Monica AI | browser-use / Playwright | Kimi 浏览器助手 |
|---------|-----------|-------------------|--------------------|--------------------|------------------------|---------------|
| 安装方式 | Chrome 扩展 | Chrome 扩展 | 桌面应用 / API | Chrome 扩展 | npm / pip 安装 | Chrome 扩展 |
| 浏览器自动化 | ✅ 45+ 工具 | ❌ 仅聊天 | ✅ 屏幕操控 | ⚠️ 有限 | ✅ 完整 | ⚠️ 有限 |
| 数据存储 | 本地 IndexedDB | OpenAI 服务器 | Anthropic 服务器 | 云端 | 本地 | 云端 |
| 开源 | ✅ 完全开源 | ❌ | ❌ | ❌ | ✅ | ❌ |
| 微信通道 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 内置终端 | ✅ 浏览器沙盒 | ❌ | ❌ | ❌ | N/A | ❌ |
| 技能/插件系统 | ✅ | GPTs | ❌ | ❌ | 代码扩展 | ❌ |
| 后台自动化 | ✅ 隐身标签页 | ❌ | ✅ | ❌ | ✅ | ❌ |
| LLM 自由度 | 自配 API Key | 仅 GPT | 仅 Claude | 多模型 | 自配 | 仅 Kimi |

### 一句话差异

- vs ChatGPT 扩展："ChatGPT 只能聊天，白雪能动手。"
- vs Claude Computer Use："Claude 要装桌面应用，白雪装个扩展就行。"
- vs Sider/Monica："它们是侧边栏聊天工具，白雪是浏览器自动化引擎。"
- vs Playwright："Playwright 是给开发者的，白雪是给所有人的。"

---

## 13. 增长与分发策略

### 自然传播机制

| 机制 | 原理 | 行动 |
|------|------|------|
| **微信回复即广告** | 每条白雪发到微信的回复都是品牌曝光——收到的人会问"这是什么？" | 回复末尾可选加一行小字"— 由白雪 AI 助手生成" |
| **技能分享** | 用户创建的技能可以导出分享，"我用白雪做了一个自动比价技能" 是天然的社交内容 | 技能导出加品牌水印 / 来源标记 |
| **截图传播** | 白雪操控网页的截图/录屏天然有视觉冲击力 | 提供"录制操作过程"功能（未来） |

### 内容平台策略

| 平台 | 内容形式 | 角度 | 频率 |
|------|---------|------|------|
| **B 站** | 3-5 分钟演示视频 | 技术演示 + 实际场景 | 周更 |
| **小红书** | 30 秒竖屏短视频 | 效率工具 / 办公神器 | 日更 |
| **微信公众号** | 长文教程 | 深度使用指南 | 双周 |
| **YouTube** | 3-5 分钟英文演示 | 国际开发者受众 | 双周 |
| **Twitter/X** | GIF + 一句话 | 开源社区 / 独立开发者 | 随时 |
| **Product Hunt** | Launch post | 首发冲榜 | 一次性 |
| **Hacker News** | Show HN | 开源 + 技术架构 | 一次性 |

### Chrome Web Store SEO

**主关键词（中文）：** AI 浏览器助手、网页自动化、浏览器自动填表、AI 操控网页
**主关键词（英文）：** AI browser assistant, web automation, browser AI agent, auto fill forms
**类别：** Productivity

---

## 14. 品牌一致性审计清单

Agent 执行品牌化改名时，逐条处理以下文件。

### 用户可见（必须改）

| 文件 | 行 | 当前内容 | 改为 |
|------|----|---------|------|
| `extension/manifest.json` | 3 | `"name": "Browser Brain Loop"` | `"name": "白雪 Snowy - AI 浏览器助手"` |
| `extension/manifest.json` | 59 | `"default_title": "Browser Brain Loop"` | `"default_title": "白雪 Snowy"` |
| `extension/sidepanel.html` | 6 | `<title>Browser Brain vNext</title>` | `<title>白雪 Snowy</title>` |
| `extension/index.html` | 6 | `<title>Browser Brain Terminal</title>` | `<title>白雪 Snowy</title>` |
| `extension/debug.html` | 6 | `<title>Browser Brain Debug</title>` | `<title>白雪 Snowy - Debug</title>` |
| `extension/debug-index.html` | 6 | `<title>Browser Brain Debug</title>` | `<title>白雪 Snowy - Debug</title>` |
| `extension/src/panel/ChatView.vue` | 850 | `Agent Terminal` | `白雪` |
| `extension/src/debug/App.vue` | 89 | `Browser Brain Debug Workspace` | `白雪 Snowy — 调试面板` |

### 系统提示词（影响 LLM 行为）

| 文件 | 行 | 当前内容 | 改为 |
|------|----|---------|------|
| `extension/src/sw/kernel/prompt/prompt-policy.browser.ts` | 228 | `"...inside Browser Brain Loop, a browser-extension agent harness."` | `"...inside Snowy (白雪), an open-source AI browser assistant."` |
| `extension/src/sw/kernel/prompt/prompt-policy.browser.ts` | 264 | 同上 | 同上 |

### 内部注释（低优先级，可后续批量替换）

| 文件 | 行 | 内容 |
|------|----|------|
| `extension/src/sw/kernel/web-chat-executor.browser.ts` | 631 | `// Keep Browser Brain Loop transcript...` |

### 测试文件（跟随源码改动更新）

- `extension/src/sw/kernel/__tests__/runtime-router.browser.test.ts`：5858, 5950, 6035
- `extension/src/sw/kernel/__tests__/cursor-help-protocol.browser.test.ts`：178, 188
- `extension/src/sw/kernel/__tests__/cursor-help-web-shared.browser.test.ts`：210

### 验证命令

```bash
# 确认用户可见位置不再出现旧名称
grep -rn "Browser Brain Loop\|Agent Terminal\|Browser Brain" \
  extension/manifest.json \
  extension/*.html \
  extension/src/panel/ \
  extension/src/debug/ \
  extension/src/sw/kernel/prompt/

# 确认 Chrome Web Store 短描述字符数
echo -n "用自然语言操控网页的 AI 助手。填表、点击、提取数据、后台自动化——装上就能用，开源免费。" | wc -m
```
