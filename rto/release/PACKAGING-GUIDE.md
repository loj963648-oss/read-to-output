# PACKAGING-GUIDE

> 把 Read-to-Output 打包成可发给粉丝的 zip。按顺序做，每步都有验证。

## 零、你要发布两个文件

| 文件 | 内容 | 给谁 |
|---|---|---|
| `read-to-output-pi.zip` | rto 主程序（本节说明） | 必发 |
| `obsidian-plugins.zip` | Obsidian 阅读插件离线包（已做好，见文末） | 随主程序一起发 |

## 一、打包前自检（必做）

在项目根目录运行：

```powershell
npm test
```

**要求**：全部通过（pass N, fail 0）。有失败先修复再打包。

## 二、要打包的内容

| 包含 | 说明 |
|---|---|
| `.pi\extensions\read-to-output.js` | 核心扩展（必须） |
| `src\` | 程序模块（必须） |
| `.read-to-output\prompts\` | 费曼/回译提示词（必须） |
| `scripts\` | 辅助脚本 |
| `start-read-to-output.cmd` | Windows 启动器（必须） |
| `start-read-to-output.command` | **macOS 启动器**（Mac 用户必须，双击运行） |
| `rto.cmd` / `rto-test.cmd` / `start-read-to-output-test.cmd` / `rto-test-reset.cmd` | 快捷方式 |
| `package.json` | Node 项目配置 |
| `README.md` | 说明 |
| `docs\` | 产品案例与补充说明 |
| `release\AI-SETUP-PROMPT.md` | Windows 安装提示词（建议复制到压缩包外单独发，或放包里） |
| `release\AI-SETUP-PROMPT-macOS.md` | macOS 兼容性内测安装提示词（Mac 用户必发） |
| `release/TOOLCHAIN-GUIDE.md` | 配套工具总览（Claudian / 语境红点 / 语法分析怎么配合） |

## 三、不要打包的内容（重要）

| 排除 | 原因 |
|---|---|
| `.read-to-output\`（除 prompts 子目录） | 你的个人学习数据（进度、队列、备份） |
| `.read-to-output-sandbox\` | 测试残留 |
| `sandbox-vault\` | 沙盒测试数据 |
| `.git\` | 版本历史 |
| 任何 `tmp-*.mjs` 文件 | 调试残留 |
| `node_modules\` | 不需要（项目零依赖） |

## 四、打包步骤

### 方法 A：手动（Windows 资源管理器）

1. 进入项目目录
2. 按住 Ctrl 选中所有要打包的文件和文件夹（见第二节），**不要**选第三节的内容
3. 右键 → 发送到 → 压缩文件夹 → 重命名为 `read-to-output-pi.zip`

### 方法 B：一键脚本（推荐，自动处理模板配置）

在项目目录运行：

```powershell
node scripts/pack-release.mjs
```

脚本会：
1. 生成**空模板**的 `.read-to-output/config.json` 和 `state.json`（不含你的真实路径和书单）
2. 复制 prompts、源码、启动器、release 文档
3. 打包为 `read-to-output-pi.zip`

> 警告：不要用 Windows 右键「发送到压缩文件夹」打包整个项目——那会把你的**个人学习数据**（真实 Obsidian 路径、书单、队列）发出去。

### 方法 C：命令（PowerShell，手动，不推荐）

在项目目录运行：

```powershell
$items = @(
  '.pi', 'src', 'scripts',
  'start-read-to-output.cmd', 'start-read-to-output.command', 'start-read-to-output-test.cmd',
  'rto.cmd', 'rto-test.cmd', 'rto-test-reset.cmd',
  'package.json', 'README.md', 'release'
)
Compress-Archive -Path $items -DestinationPath '..\read-to-output-pi.zip' -Force
```

> 注意：`.pi` 会包含全部内容，其中 `.pi\extensions` 是要的，其余 pi 配置（如 settings）一般不存在于项目内，不影响。打包后检查 zip 里 `.read-to-output` 是否混入（不应有）。

### 打包后验证

1. 把 zip 复制到一个**全新的空目录**，解压
2. 运行 `node -e "const {loadRuntime}=await import('./src/state.js'); await loadRuntime('.')"` —— 应能加载（配置路径是模板 `C:/path/to/your/Obsidian Vault`，books 为 0）
3. 运行 `start-read-to-output.cmd`（Windows）或 `bash start-read-to-output.command`（macOS）—— 应该进入首次引导（让你填 Obsidian 路径）

> 注意：发布包不附带开发测试目录；使用者无需运行 `npm test`。开发者应只在自己的源码工作区运行测试，并确保测试样例不含个人路径或学习数据。

**验证这一步不能省**：很多人收到的包打不开，就是因为作者没试过解压后的版本。

## 五、发给粉丝时附带的说明

```text
📚 Read-to-Output 安装包

安装步骤（有 AI 帮忙，很简单）：
1. 把 zip 解压到一个文件夹（路径别带中文和空格）
2. 打开你电脑上的 WorkBuddy / Trae / Claude Code
3. Windows 把"AI-SETUP-PROMPT.md"、macOS 把"AI-SETUP-PROMPT-macOS.md"里的内容整段复制发给它
4. 它会一步步帮你装好

你需要准备：
- 一个 Obsidian 笔记库（没有就到 obsidian.md 免费下载）
- 一个 DeepSeek API key（platform.deepseek.com 注册，控制台创建，充 10 块钱够用很久）

装好后：双击 start-read-to-output.cmd（Windows）或在终端运行 `bash start-read-to-output.command`（macOS）开始
第一次可以输入"演示一下"看完整流程
```

## 六、版本记录建议

每次打包，在 zip 文件名或包内 README 顶部标注版本和日期：

```text
read-to-output-pi v0.10.6-beta.2（2026-09-09）
```

可以在 `package.json` 的 version 字段改号（当前 0.10.4），改完记得 `npm test` 再打包。


## 七、Obsidian 插件离线包（已做好，不用重新打）

`obsidian-plugins.zip` 已经生成在项目根目录，包含：

- realclaudian（Claudian v2.0.34）：Obsidian 里嵌入 AI 助手
- context-lens（Context Lens v1.0.2）：双击英文词查语境释义

**重要**：这个包已排除两个插件的 data.json（里面是作者自己的 API key 和缓存），粉丝安装后需要自己配置 API key。不要重新打包 Obsidian 插件目录，否则会把你的 key 发出去。

粉丝安装方法（已在 AI-SETUP-PROMPT 第 7 步写好）：解压后把两个文件夹复制到 `.obsidian/plugins/` 下，重启 Obsidian 启用。
