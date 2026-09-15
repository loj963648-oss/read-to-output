import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { advanceCadence } from "./cadence.js";
import { randomUUID } from "node:crypto";
import { resolveAnchor } from "./anchor-resolution.js";
import { extractNoteTitle, normalizeNoteTitle, stripNoteTitle } from "./summary-normalize.js";

const START_MARKER = "%%起点%%";
const END_MARKER = "%%终点%%";

function assertSandbox(runtime) {
  if (runtime.config.sandbox !== true) throw new Error("拒绝写入：当前不是沙盒模式");
  const expectedRoot = path.resolve(runtime.projectRoot, "sandbox-vault");
  if (path.resolve(runtime.config.vaultRoot) !== expectedRoot) {
    throw new Error("拒绝写入：沙盒库路径不在项目 sandbox-vault");
  }
}

export async function atomicWrite(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, target);
}

export function removeReadingMarkers(text) {
  return text
    .replace(/^\s*%%(?:起点|终点)%%\s*(?:\r?\n|$)/gmu, "")
    .replace(/\n{3,}/gu, "\n\n");
}

/**
 * 把锚点扩展到所在行的段落边界：
 * - startAnchor 扩展到行首（包含锚点之前的同行内容）
 * - endAnchor 扩展到行尾（包含锚点之后的同行内容）
 * 用于修复旧的手动规划里“锚点截断在行中间”导致的非法标记。
 */
export function expandAnchorToBoundary(text, anchor, { fromStart }) {
  const index = text.indexOf(anchor);
  if (index < 0) return anchor;
  if (fromStart) {
    const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
    return text.slice(lineStart, index + anchor.length).trim();
  }
  const nextBreak = text.indexOf("\n", index + anchor.length);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  return text.slice(index, lineEnd).trim();
}

export function insertReadingMarkers(text, startAnchor, endAnchor) {
  const cleaned = removeReadingMarkers(text);
  const start = resolveAnchor(cleaned, startAnchor);
  const end = resolveAnchor(cleaned, endAnchor);
  if (start.count !== 1 || end.count !== 1) {
    throw new Error(`分段锚点不唯一：起点 ${start.count} 个，终点 ${end.count} 个`);
  }
  const startIndex = cleaned.indexOf(start.anchor);
  const endIndex = cleaned.indexOf(end.anchor, startIndex);
  if (startIndex < 0 || endIndex < startIndex) throw new Error("分段锚点不存在或顺序错误");

  const startLine = cleaned.lastIndexOf("\n", Math.max(0, startIndex - 1)) + 1;
  const endTextIndex = endIndex + end.anchor.length;
  const nextBreak = cleaned.indexOf("\n", endTextIndex);
  const endLine = nextBreak === -1 ? cleaned.length : nextBreak;
  if (cleaned.slice(startLine, startIndex).trim() || cleaned.slice(endTextIndex, endLine).trim()) {
    throw new Error("锚点不是完整段落边界，拒绝写入非独占标记");
  }

  return [
    cleaned.slice(0, startLine),
    `${START_MARKER}\n`,
    cleaned.slice(startLine, endLine),
    `\n${END_MARKER}`,
    cleaned.slice(endLine),
  ].join("");
}

export async function markSegment(chapterPath, segment) {
  const chapter = await readFile(chapterPath, "utf8");
  await atomicWrite(
    chapterPath,
    insertReadingMarkers(chapter, segment.startAnchor, segment.endAnchor),
  );
}

export async function prepareSandboxReading(runtime, session) {
  if (runtime.config.sandbox !== true) return { sandbox: false };
  assertSandbox(runtime);
  const chapterPath = path.resolve(runtime.config.vaultRoot, runtime.state.books[session.bookId].chapterFile);
  await markSegment(chapterPath, {
    startAnchor: session.startAnchor,
    endAnchor: session.actualEndAnchor,
  });
  return { sandbox: true, chapterPath };
}

function renderSandboxProgress(state) {
  const book = state.books[state.lastBookId];
  const completed = book.completedSegments.length ? book.completedSegments.join("、") : "无";
  return [
    "# Read-to-Output 沙盒学习进度",
    "",
    "> 这是测试文件。任何修改都不会进入真实 Obsidian。",
    "",
    "## 当前进度",
    "",
    `- 测试书：第 ${book.chapterNumber} 章`,
    `- 已完成：${completed}`,
    `- 下一段：${book.nextSegment?.id ?? "本章完成"}`,
    "",
    "## 英语输出节奏",
    "",
    `- 普通阅读场计数：${state.cadence.normalReadingCount}`,
    `- 下次场次：${state.cadence.nextSession === "mixed" ? "混合场" : "普通阅读场"}`,
    `- 新回译参考量：${state.cadence.newBacktranslationWords} 词`,
    "",
  ].join("\n");
}

export async function finalizeSandboxSession(runtime, session, summaryText, noteTitle) {
  if (runtime.config.sandbox !== true) return { sandbox: false };
  assertSandbox(runtime);
  if (!summaryText.trim()) throw new Error("沙盒核对结果为空，未执行存档和进度推进");

  const statePath = path.join(runtime.runtimeRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const book = state.books[session.bookId];
  if (!book || book.nextSegment?.id !== session.segmentId) {
    throw new Error("沙盒状态已变化，拒绝用旧场次推进进度");
  }

  const chapterPath = path.resolve(runtime.config.vaultRoot, book.chapterFile);
  const cleanedChapter = removeReadingMarkers(await readFile(chapterPath, "utf8"));
  await atomicWrite(chapterPath, cleanedChapter);

  const currentIndex = book.currentSegmentIndex;
  const nextIndex = currentIndex + 1;
  const nextSegment = book.segments[nextIndex] ?? null;
  const nextState = {
    ...state,
    generatedAt: new Date().toISOString(),
    cadence: advanceCadence({ cadence: state.cadence }, session.sessionType),
    books: {
      ...state.books,
      [session.bookId]: {
        ...book,
        lastCompleted: session.segmentId,
        lastActivityDate: new Date().toISOString().slice(0, 10),
        phase: nextSegment ? "ready_to_read" : "chapter_complete",
        currentSegmentIndex: nextIndex,
        completedSegments: [...book.completedSegments, session.segmentId],
        nextSegment,
      },
    },
  };

  const resolvedNoteTitle = normalizeNoteTitle(noteTitle ?? extractNoteTitle(summaryText));
  const notePath = path.join(
    runtime.config.vaultRoot,
    "费曼笔记",
    `Ch${session.chapterNumber}-${session.segmentId}-${resolvedNoteTitle}.md`,
  );
  await atomicWrite(notePath, [
    `# ${resolvedNoteTitle}`,
    "",
    `**书籍：** ${session.bookName}`,
    `**章节：** Ch${session.chapterNumber} ${session.chapterTitle}`,
    `**分段：** ${session.segmentId}`,
    `**日期：** ${new Date().toISOString().slice(0, 10)}`,
    "",
    stripNoteTitle(summaryText),
    "",
  ].join("\n"));
  await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  await atomicWrite(
    path.join(runtime.config.vaultRoot, runtime.config.progressFile),
    renderSandboxProgress(nextState),
  );

  if (nextSegment) await markSegment(chapterPath, nextSegment);
  return { sandbox: true, notePath, noteTitle: resolvedNoteTitle, nextSegmentId: nextSegment?.id ?? null };
}
