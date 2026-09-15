const ORIGINAL_SUPPLEMENT_BLOCK = /(^[ \t]*-\s*(?:\*\*)?原文补充(?:\*\*)?[：:](?:\*\*)?[ \t]*)([\s\S]*?)(?=^[ \t]*-\s*(?:\*\*)?本段无法确认(?:\*\*)?[：:](?:\*\*)?)/mu;

const CLARIFICATION_BLOCK = /(^[ \t]*(?:\*\*)?追问后澄清(?:\*\*)?[：:](?:\*\*)?[ \t]*\r?\n)([\s\S]*?)(?=^[ \t]*(?:\*\*)?还是有点困惑的(?:\*\*)?[：:])/mu;
const NOTE_TITLE_LINE = /^[ \t]*(?:\*\*)?本次笔记标题[：:](?:\*\*)?[ \t]*(.+?)[ \t]*$/mu;
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F]/gu;

function explicitlySaysNothingWasAdded(text) {
  const compact = text.replace(/\s+/gu, "");
  return /(?:无|没有)(?:任何)?(?:额外|新增)(?:关键)?(?:内容|要点|信息|遗漏|补充)/u.test(compact);
}

export function normalizeNoteTitle(title, fallback = "本段费曼笔记") {
  const cleaned = String(title ?? "")
    .replace(/[`*_]/gu, "")
    .replace(INVALID_FILENAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[，,。.;；:：—-]+|[，,。.;；:：—-]+$/gu, "")
    .trim()
    .slice(0, 36)
    .trim();
  return cleaned.length >= 2 && !/^(?:无|暂无|标题)$/u.test(cleaned) ? cleaned : fallback;
}

export function extractNoteTitle(summary, fallback = "本段费曼笔记") {
  return normalizeNoteTitle(String(summary ?? "").match(NOTE_TITLE_LINE)?.[1], fallback);
}

export function stripNoteTitle(summary) {
  return String(summary ?? "").replace(NOTE_TITLE_LINE, "").trim();
}

export function normalizeVerificationSummary(
  summary,
  { sandbox = false, real = false, studentTurnsUsed = null } = {},
) {
  let normalized = summary.replace(
    ORIGINAL_SUPPLEMENT_BLOCK,
    (block, prefix, body) => (explicitlySaysNothingWasAdded(body) ? `${prefix}无\n` : block),
  );

  // 费曼阶段没有发生任何追问时，禁止模型补造“追问后澄清”：
  // 该栏目只能写“无（本场没有发生追问）”，不允许用原文或外部知识冒充用户澄清。
  if (studentTurnsUsed === 0) {
    normalized = normalized.replace(
      CLARIFICATION_BLOCK,
      (block, prefix) => `${prefix}- 无（本场没有发生追问）\n`,
    );
  }

  if (sandbox) {
    normalized = normalized.replace(
      /(?:\*\*)?本结果尚未写入 Obsidian。(?:\*\*)?/gu,
      "本结果仅写入测试沙盒，不会写入真实 Obsidian。",
    );
  } else if (real) {
    normalized = normalized.replace(
      /(?:\*\*)?本结果尚未写入 Obsidian。(?:\*\*)?/gu,
      "本结果将在本轮结束时由程序尝试写入真实 Obsidian，最终以存档状态提示为准。",
    );
  }
  return normalized;
}
