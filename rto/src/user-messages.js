/**
 * 用户可见错误消息翻译器。
 * 把内部技术错误映射成新人能理解的话；未识别的错误原样展示并附通用建议。
 */
const KNOWN_PATTERNS = [
  {
    pattern: /锚点不是完整段落边界|分段锚点不唯一|锚点不存在或顺序错误/u,
    message: "阅读范围标记出了点问题，程序没能自动处理。稍后重试一次，或者输入 /learn diagnose 把信息发给我们。",
  },
  {
    pattern: /学习进度快照有效|freshness|学习进度\.md 已变化|状态快照|sourceSnapshot/u,
    message: "检测到你的学习进度文件被外部修改过（可能是在 Obsidian 里手动编辑了）。为安全起见本次操作已暂停，确认修改没问题后重试。",
  },
  {
    pattern: /学习进度缺少|进度文件/u,
    message: "学习进度文件缺失或格式不对。输入 /learn diagnose 查看详情，必要时重新运行首次设置。",
  },
  {
    pattern: /config\.books|state\.books|缺少图书|找不到图书|图书配置/u,
    message: "图书配置不完整。输入 /learn add-book 重新导入这本书。",
  },
  {
    pattern: /章节文件|chapterFile|章节路径/u,
    message: "找不到这本书的章节文件（可能在 Obsidian 里被移动或删除了）。确认文件位置后重试。",
  },
  {
    pattern: /Obsidian 库路径不存在/u,
    message: "这个 Obsidian 库路径不存在。请检查路径是否正确（注意是文件夹的完整路径）。",
  },
  {
    pattern: /已存在同名图书/u,
    message: "已经导入过同名的书了。可以直接说“继续”开始读，或用 /learn add-book 导入另一本。",
  },
  {
    pattern: /仅支持 EPUB 和 TXT/u,
    message: "目前支持 EPUB 和 TXT 格式的电子书。PDF 暂不支持，请把书转成 EPUB 或 TXT 后再导入。",
  },
  {
    pattern: /不是有效的 ZIP|EPUB 缺少|spine 为空|无法确定章节顺序/u,
    message: "这个 EPUB 文件可能损坏或不完整，程序读不出章节结构。换一个文件试试。",
  },
  {
    pattern: /API key 不能为空/u,
    message: "API key 不能为空。请从服务商官网复制完整的 key（通常以 sk- 开头）。",
  },
  {
    pattern: /当前没有进行中的学习场|没有进行中的学习场/u,
    message: "当前没有进行中的学习。先说“今天学什么”或“继续”开始。",
  },
  {
    pattern: /请先完成并核对一个阅读分段/u,
    message: "回译要用你读过的内容来出题，所以得先完整读一段并完成核对。先继续阅读吧。",
  },
  {
    pattern: /分段计划没有未完成|下一分段计划无法解析/u,
    message: "分段计划状态异常（可能被手动编辑过）。输入 /learn diagnose 查看详情，或重新规划本章。",
  },
  {
    pattern: /费曼笔记已存在|拒绝覆盖/u,
    message: "今天的笔记已经存在，程序不会覆盖它。可以明天再完成这一段的核对，或检查 Obsidian 里的同名笔记。",
  },
  {
    pattern: /没有返回 RTO_BT_SELECTION|没有返回 RTO_BT_CORRECTION|不是有效 JSON/u,
    message: "模型返回的格式没通过校验，系统已自动重试。若多次出现，输入“继续回译”再试。",
  },
  {
    pattern: /不能从 .* 直接切换到/u,
    message: "当前状态不允许这一步操作。按卡片上的提示走就行。",
  },
  {
    pattern: /无法撤回|无法退回/u,
    message: "这一步已经完成，不能撤回了。",
  },
  {
    pattern: /知识复习队列/u,
    message: "记忆队列暂时不可用，不影响正常阅读。稍后重试。",
  },
  {
    pattern: /回译节奏更新需要|writeMode|config\.writeMode/u,
    message: "系统写入配置异常（writeMode 未开启）。输入 /learn diagnose 查看详情。",
  },
];

export function translateUserError(message) {
  const text = String(message ?? "");
  for (const { pattern, message: friendly } of KNOWN_PATTERNS) {
    if (pattern.test(text)) return friendly;
  }
  return `出错了：${text || "未知错误"}。如果反复出现，输入 /learn diagnose 查看详情。`;
}
