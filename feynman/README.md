# Read to Output｜英文原版阅读与输出系统

这是一套面向 Claude Code 和 Codex 的英文原版书学习 Skill。它把阅读、理解检验、原文核对和英语输出连接成一个持续运行的学习闭环，而不是只做一次费曼问答。

核心流程：

> 英文原版阅读 → 自然分段 → 开卷费曼讲述 → 已读原文核对 → 选择性知识复习 → 按阅读节奏进行回译训练

## 它解决什么问题

- 根据时间或章节边界规划阅读范围，并在 Obsidian 中维护实际进度。
- 让 AI 扮演“不替你脑补的学生”，只追问你已经讲出的关键逻辑缺口。
- 费曼讲述允许翻看刚读过的原文，检验的是理解，不是背诵人名、日期和事件清单。
- 讲述结束后只根据本次已读原文核对，区分准确理解、需要修正、合理推断和原文补充。
- 普通知识不制造强制复习债；只有你主动选择长期记住的内容才进入知识复习队列。
- 默认完成两次普通阅读后，下一场进入“阅读＋回译”的混合场；回译批改提供最小修改版、自然表达版和针对性重写。
- 章节分段时，S1、S2 等中间段只做进度存档；完成整份章节计划后才结算一次阅读场，不会在第一段结束后突然插入回译。

## 适合哪些材料

更适合有连续语境、需要理解概念或因果关系的英文材料，例如：

- 历史、社会科学、思想与通识类著作
- 传记、纪实作品和叙事性非虚构
- 有连续论证的分析文章
- 以解释概念和机制为主的教材章节

不太适合把它当作主要工作流处理以下材料：

- API 文档、命令手册和参数表
- 代码参考、配置清单和故障排查页面
- 以查找单个事实为主、缺少连续论述的资料

这些材料更适合检索、示例验证或任务式练习，而不是费曼讲述整章内容。

## 目录结构

```text
read-to-output/
├── README.md
├── CHANGELOG.md
└── feynman/
    ├── SKILL.md
    ├── agents/
    │   └── openai.yaml
    └── references/
        └── backtranslation.md
```

安装时要复制整个 `feynman` 文件夹，不要只复制 `SKILL.md`。

## 使用前准备

1. 准备一个 Obsidian 笔记库。
2. 将英文原版书转换为 Markdown；建议每章一个文件，放在该书目录的 `Chapters/` 下。
3. 安装 Claude Code 或 Codex，并确保它可以读取你的 Obsidian 笔记库和书籍目录。

本仓库不包含任何书籍原文、个人笔记或个人路径。

## 安装到 Claude Code

下载仓库后，把整个 `feynman` 文件夹复制到：

- Windows：`%USERPROFILE%\.claude\skills\feynman\`
- macOS / Linux：`~/.claude/skills/feynman/`

## 安装到 Codex

下载仓库后，把整个 `feynman` 文件夹复制到：

- Windows：`%USERPROFILE%\.codex\skills\feynman\`
- macOS / Linux：`~/.codex/skills/feynman/`

## 个性化配置

打开安装后的 `feynman/SKILL.md`：

1. 全局替换 `{{VAULT_PATH}}` 为你的 Obsidian 笔记库绝对路径。
2. 在文件末尾“我的学习材料”中填写书名和书籍目录，并替换 `{{BOOK_DIR}}`。
3. 确认每本书的章节 Markdown 位于对应书籍目录的 `Chapters/` 下。

Windows 路径建议使用 `/`，例如：

```text
C:/Users/你的用户名/Documents/Obsidian Vault
```

配置完成后，新开一个 Claude Code 或 Codex 会话，再输入：

```text
$feynman
```

也可以输入 `/feynman`，或直接说“开始英语学习”“继续读原版书”。不同客户端支持的显式调用方式可能不同，自然语言入口始终可用。

## 从旧版更新

如果已经安装过旧版：

1. 先备份原来的 `feynman` 文件夹，至少记下已经配置好的 Vault 路径、书名和书籍目录。
2. 用仓库中的整个 `feynman` 文件夹替换旧版，而不是只替换主文件。
3. 把自己的路径和书目配置恢复到新版 `SKILL.md`。
4. 确认没有残留 `{{VAULT_PATH}}`、`{{BOOK_DIR}}` 或 `[书名]` 占位符。
5. 新开一个 Claude Code 或 Codex 会话进行验证。

更新 Skill 不会删除 Obsidian 中已有的 `学习进度.md`、章节、费曼笔记或回译记录。

也可以把下载后的仓库文件夹交给 Claude Code 或 Codex，并发送：

```text
请用当前文件夹中的 feynman 新版 Skill 更新我已经安装的旧版。

先检查用户目录下 .claude/skills/feynman 和 .codex/skills/feynman 哪个实际存在；备份现有 Skill，并读取、保留旧版 SKILL.md（或更早版本的 skill.md）中已经配置的 Vault 路径、书名和书籍目录。然后用当前文件夹中的整个 feynman 目录更新实际安装位置，恢复这些配置。

不要修改我的 Obsidian Vault、学习进度、笔记、章节文件、插件或模型配置。最后确认 SKILL.md、references/backtranslation.md 均存在，确认没有残留占位符，并提醒我新开会话验证。
```

## 隐私与数据

这个 Skill 只会按你在 `SKILL.md` 中配置的路径读取或更新本地学习文件。公开仓库本身不需要上传书籍原文、Obsidian 笔记、API Key 或模型配置。

## 许可

本仓库暂未附加开源许可证。在作者明确添加许可证前，代码与文档仍保留默认著作权；下载者可以按说明安装和个人使用，但不应据此推定拥有再发布或商业使用许可。

