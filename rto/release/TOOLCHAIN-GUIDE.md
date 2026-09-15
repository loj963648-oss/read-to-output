# Read-to-Output 配套工具总览

> 先看这一页，再决定装哪些。整套系统 = 1 个主程序 + 3 个可选插件，按"读 → 讲 → 练"三阶段配合。

## 一张图看懂

```
┌────────────────────────────────────────────────┐
│              一次完整的学习流程                  │
├────────────────────────────────────────────────┤
│  ① 阅读（在 Obsidian 里）                       │
│     ├─ Claudian 侧边栏：AI 实时拆长难句、解析语法│
│     ├─ Context Lens：双击英文词 → 语境释义/搭配  │
│     └─ 语法分析 skill：选中句子 → 完整语法拆解   │
│                                                │
│  ② 费曼（在 rto 终端里）                        │
│     读完一段 → 用自己的话讲 → AI 当笨学生追问    │
│     → 原文核对 → 自动存档到 Obsidian            │
│                                                │
│  ③ 练习（在 rto 终端里）                        │
│     ├─ 回译：译回英文 + 分层批改                │
│     ├─ 错题本：拼写错误自动沉淀                 │
│     └─ 记忆队列：想记住的知识点定时复习          │
└────────────────────────────────────────────────┘
```

## 工具清单

| 工具 | 装在哪 | 干什么 | 必需? |
|---|---|---|---|
| **Read-to-Output（rto）** | 独立终端程序（Windows/Mac 双击启动） | 阅读流程 + 费曼 + 核对 + 回译 + 复习主引擎 | ✅ 必需 |
| **Claudian** | Obsidian 插件 | 侧边栏嵌入 AI（Claude Code / Codex / pi），实时拆长难句、解析语法 | 推荐 |
| **Context Lens（语境红点）** | Obsidian 插件 | 双击英文词 → 识别固定搭配 + 确定本句词义（本地缓存） | 推荐 |
| **语法分析 skill** | AI 助手技能（配合 pi/Claude Code） | 选中英文句子 → 翻译 + 拆语法 + 词汇 + 背景 | 可选 |
| **视频口语精听** | Obsidian 插件 | 导入 YouTube/B站英文字幕，句首回放、通勤听 | 可选 |

## 各工具安装要点

### Claudian（Obsidian 插件）
- 国内无法访问插件市场？用离线包：解压 `obsidian-plugins.zip`，把 `realclaudian` 文件夹复制到 `.obsidian/plugins/` 下，重启 Obsidian 后启用
- 本质：把终端里的 Claude Code / Codex / pi 嵌进 Obsidian 侧边栏
- **模型取决于你电脑上配的 AI**：如果你的 pi/Claude Code 配的是 DeepSeek，Claudian 里就能选 DeepSeek 模型
- 用法：阅读时选中句子 → 侧边栏让它拆长难句、解析语法

### Context Lens 语境红点（Obsidian 插件）
- 安装方式同上（离线包里的 `context-lens` 文件夹），无需翻墙
- 设置里需要配置：
  - **API Key**：在服务商官网创建（支持任何 OpenAI 兼容接口）
  - **API 地址**：默认 DeepSeek（`https://api.deepseek.com`），**可以改成任意 OpenAI 兼容服务**
  - **模型**：选你 key 对应的模型名（如 `deepseek-chat` / `deepseek-reasoner` / 其他）
- 想换更便宜/更好的模型？只要服务商提供 OpenAI 兼容 API，改"API 地址 + key + 模型名"三个字段即可
- 用法：阅读时双击英文词 → 显示本句中的词义和固定搭配（相同词+相同段落自动复用缓存，不重复扣费）

### 语法分析 skill
- 配合 pi 使用：选中英文句子后输入 `/grammar-analysis`（或发送数字 1）
- 输出：自然翻译 → 语法拆解 → 核心词汇 → 必要背景
- 用途：Claudian 拆完还不懂的句子，用它做完整分析

## 推荐安装顺序（新人）

```
第 1 步：装 rto（主程序，见 AI 安装引导提示词）
第 2 步：装 Obsidian + Claudian + Context Lens（阅读三件套）
第 3 步：装语法分析 skill（进阶）
第 4 步：视频精听（有需要再装）
```

## 常见问题

**Q：Context Lens 只能用 DeepSeek 吗？**
A：不是。API 地址和模型名都可改，任何 OpenAI 兼容服务都能用（OpenRouter、Kimi、通义、硅基流动等）。

**Q：Claudian 里能选哪些模型？**
A：取决于你电脑上 AI 助手（pi / Claude Code / Codex）配置的模型。配了 DeepSeek 就能选 DeepSeek。

**Q：这些工具的数据会同步吗？**
A：会。rto 的学习进度、费曼笔记、错题本直接写进你的 Obsidian 库，Claudian 和 Context Lens 也在库内工作，所有笔记都是你自己的文件。
