import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

function assertInside(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 不在允许目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

function chapterNumberFromFile(fileName) {
  const match = fileName.match(/^Ch(\d+)(?:[-_].*)?\.md$/iu);
  return match ? Number(match[1]) : null;
}

function titleFromFileName(fileName) {
  const match = fileName.match(/^Ch\d+[-_](.+)\.md$/iu);
  if (!match) return null;
  return match[1].replace(/[-_]/gu, " ").replace(/\s+/gu, " ").trim();
}

async function titleFromChapterFile(chapterPath) {
  try {
    const text = await readFile(chapterPath, "utf8");
    const firstHeading = text.split(/\r?\n/u).find((line) => /^#\s+/u.test(line.trim()));
    if (firstHeading) {
      const title = firstHeading.trim().replace(/^#\s+/u, "").replace(/^Chapter\s+\d+[:\s]*/iu, "").trim();
      if (title) return title;
    }
  } catch {
    // 读不到标题时退回文件名
  }
  return null;
}

/**
 * 扫描章节目录，找到当前章节之后的下一章。
 * 返回 null 表示已经是最后一章（或目录里没有可识别的下一章）。
 */
export async function findNextChapter(runtime, bookId) {
  const bookConfig = runtime.config.books.find((item) => item.id === bookId);
  const book = runtime.state.books[bookId];
  if (!bookConfig || !book) throw new Error(`缺少图书信息：${bookId}`);
  const currentNumber = book.chapterNumber;
  const chapterRoot = assertInside(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, bookConfig.chapterDirectory),
    "章节目录",
  );
  let entries;
  try {
    entries = await readdir(chapterRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && chapterNumberFromFile(entry.name) !== null)
    .map((entry) => ({ name: entry.name, number: chapterNumberFromFile(entry.name) }))
    .filter((candidate) => candidate.number > currentNumber)
    .sort((left, right) => left.number - right.number);
  if (!candidates.length) return null;
  const next = candidates[0];
  const chapterFile = path.join(bookConfig.chapterDirectory, next.name).replace(/\\/gu, "/");
  const chapterPath = path.join(runtime.config.vaultRoot, chapterFile);
  const title = (await titleFromChapterFile(chapterPath)) ?? titleFromFileName(next.name) ?? `Chapter ${next.number}`;
  return {
    chapterNumber: next.number,
    chapterTitle: title,
    chapterFile,
  };
}

/**
 * 在进度文本中删除旧的“### 分段计划”区块，并把“当前章节”和“章节文件”字段更新到下一章。
 */
export function advanceProgressFields(progress, bookName, nextChapter) {
  const heading = `## ${bookName}`;
  const start = progress.indexOf(heading);
  if (start < 0) throw new Error(`学习进度缺少图书区块：${bookName}`);
  const end = progress.indexOf("\n## ", start + heading.length);
  const boundary = end < 0 ? progress.length : end;
  const section = progress.slice(start, boundary);
  const withoutPlan = section.replace(
    /\r?\n\s*### 分段计划：[^\r\n]*\r?\n[\s\S]*?(?=\r?\n## |\s*$)/u,
    "",
  );
  const chapterFile = nextChapter.chapterFile.replace(/\\/gu, "/");
  let updated = withoutPlan.replace(
    /^- 当前章节：.*$/mu,
    `- 当前章节：第 ${nextChapter.chapterNumber} 章（${nextChapter.chapterTitle}）🚧 待规划`,
  );
  updated = updated.replace(
    /^- 章节文件：.*$/mu,
    `- 章节文件：\`${chapterFile}\``,
  );
  return `${progress.slice(0, start)}${updated}${progress.slice(boundary)}`;
}

/**
 * 检查目录里是否存在后续章节（用于提示“这是最后一章”）。
 */
export async function hasNextChapter(runtime, bookId) {
  return (await findNextChapter(runtime, bookId)) !== null;
}
