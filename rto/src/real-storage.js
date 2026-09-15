import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, expandAnchorToBoundary, insertReadingMarkers, removeReadingMarkers } from "./sandbox.js";
import { advanceProgressFields, findNextChapter } from "./chapter-advance.js";
import { advanceCadence } from "./cadence.js";
import { bookNotesRoot } from "./book-storage.js";
import { extractNoteTitle, normalizeNoteTitle, stripNoteTitle } from "./summary-normalize.js";
import { readPlanAnchors, withPlanAnchors } from "./plan-metadata.js";
import { resolveAnchor } from "./anchor-resolution.js";

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertWithin(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 不在允许目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

function assertRealWrite(runtime) {
  if (runtime.config.sandbox === true || runtime.config.writeMode !== "real") {
    throw new Error("真实写入未启用：config.writeMode 必须明确设为 real");
  }
  if (runtime.freshness.status !== "current") {
    throw new Error(`拒绝写入：${runtime.freshness.reason}`);
  }
}

function chapterPathFor(runtime, bookId) {
  const book = runtime.state.books[bookId];
  if (!book?.chapterFile) throw new Error(`缺少图书章节路径：${bookId}`);
  const target = assertWithin(runtime.config.vaultRoot, path.join(runtime.config.vaultRoot, book.chapterFile), "章节文件");
  if (path.extname(target).toLowerCase() !== ".md") throw new Error("章节文件必须是 Markdown");
  return target;
}

function cleanPlanAnchor(anchor) {
  return anchor.trim().replace(/^(?:\.{3}|…)/u, "").replace(/(?:\.{3}|…)$/u, "").trim();
}

function shortAnchor(anchor) {
  return anchor.length > 110 ? `${anchor.slice(0, 107).trimEnd()}...` : anchor;
}

function assertNoNarrativeGap(chapter, completedEndAnchor, nextStartAnchor) {
  const completed = resolveAnchor(chapter, completedEndAnchor);
  const next = resolveAnchor(chapter, nextStartAnchor);
  if (completed.count !== 1 || next.count !== 1) return;
  const completedIndex = chapter.indexOf(completed.anchor);
  const nextIndex = chapter.indexOf(next.anchor, completedIndex + completed.anchor.length);
  if (completedIndex < 0 || nextIndex < 0) return;
  const gap = chapter.slice(completedIndex + completed.anchor.length, nextIndex)
    .replace(/%%(?:起点|终点)%%/gu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/^#{1,6}.*$/gmu, "");
  const words = gap.trim().split(/\s+/u).filter(Boolean);
  if (words.length >= 12) {
    throw new Error("下一分段与当前终点之间仍有未纳入计划的正文，拒绝跳段推进");
  }
}

function parsePlanLine(line) {
  const id = line.match(/^- \[[ x~]\] ([^（：|\s]+)/u)?.[1];
  const words = Number(line.match(/\|\s*~?(\d+)\s*词/u)?.[1]);
  const anchors = line.match(/\|\s*起\s*["“](.*?)["”]\s*止\s*["“](.*?)["”]/u);
  if (!id || !Number.isFinite(words) || !anchors) return null;
  const stored = readPlanAnchors(line);
  return {
    id,
    sessionType: line.includes("混合场") ? "mixed" : "ordinary",
    plannedWords: words,
    measuredWords: words,
    start: anchors[1],
    end: anchors[2],
    startAnchor: stored?.startAnchor ?? cleanPlanAnchor(anchors[1]),
    endAnchor: stored?.endAnchor ?? cleanPlanAnchor(anchors[2]),
  };
}

function replaceBookField(progress, bookName, field, value) {
  const heading = `## ${bookName}`;
  const start = progress.indexOf(heading);
  if (start < 0) throw new Error(`学习进度缺少图书区块：${bookName}`);
  const end = progress.indexOf("\n## ", start + heading.length);
  const boundary = end < 0 ? progress.length : end;
  const section = progress.slice(start, boundary);
  const pattern = new RegExp(`^- ${field}：.*$`, "mu");
  if (!pattern.test(section)) throw new Error(`图书区块缺少字段：${field}`);
  const updated = section.replace(pattern, `- ${field}：${value}`);
  return `${progress.slice(0, start)}${updated}${progress.slice(boundary)}`;
}

function replaceGlobalField(progress, field, value) {
  const pattern = new RegExp(`^- ${field}：.*$`, "mu");
  const matches = [...progress.matchAll(new RegExp(pattern.source, "gmu"))];
  if (matches.length !== 1) throw new Error(`全局字段 ${field} 应唯一存在，当前 ${matches.length} 个`);
  return progress.replace(pattern, `- ${field}：${value}`);
}

function extractScore(summary) {
  return summary.match(/整体[：:][^\n]*?([1-5](?:\.\d+)?)\s*(?:分|\/5)/u)?.[1] ?? "—";
}

function extractIssue(summary) {
  const issue = summary.match(/讲得绕的[：:]\s*([^\n]+)/u)?.[1]?.trim();
  return !issue || /^(?:无|—)/u.test(issue) ? "—" : issue.replace(/\|/gu, "／");
}

function insertExpressionRow(progress, session, summary, date) {
  const heading = "## 表达力追踪";
  const start = progress.indexOf(heading);
  if (start < 0) throw new Error("学习进度缺少表达力追踪区块");
  const separatorStart = progress.indexOf("|", progress.indexOf("\n", start));
  const separatorEnd = progress.indexOf("\n", progress.indexOf("\n", separatorStart) + 1);
  if (separatorStart < 0 || separatorEnd < 0) throw new Error("表达力追踪表格格式无效");
  const segmentLabel = session.remainingStartAnchor
    ? `Ch${session.chapterNumber}-${session.segmentId}（部分）`
    : `Ch${session.chapterNumber}-${session.segmentId}`;
  const minutes = session.accumulatedReadingMs > 0
    ? Math.max(1, Math.round(session.accumulatedReadingMs / 60000))
    : null;
  const speed = minutes
    ? Math.round((session.sourceWords / minutes) * 10) / 10
    : null;
  const duration = minutes === null ? "—" : `~${minutes}`;
  const speedText = speed === null ? "—" : `~${speed}(自动计时)`;
  const row = `| ${date} | ${segmentLabel} | ~${session.sourceWords} | ${duration} | ${speedText} | ${extractScore(summary)} | ${extractIssue(summary)} | ${session.studentTurnsUsed} |`;
  return `${progress.slice(0, separatorEnd + 1)}${row}\n${progress.slice(separatorEnd + 1)}`;
}


function readingSpeedOf(session) {
  if (!session.accumulatedReadingMs || session.accumulatedReadingMs < 60000) return null;
  return Math.round((session.sourceWords / (session.accumulatedReadingMs / 60000)) * 10) / 10;
}

export function fixPlanLine(progress, segment) {
  const escapedId = segment.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `(^- \\[ \\] ${escapedId}[^\\n]*?)\\| ~\\d+ 词 \\| 起 ["“][^\\n]*?["”] 止 ["“][^\\n]*?["”]`,
    "mu",
  );
  if (!pattern.test(progress)) return progress;
  return progress.replace(
    pattern,
    `$1| ~${segment.plannedWords} 词 | 起 "${segment.start}" 止 "${segment.end}"`,
  );
}

function updateProgress(progress, runtime, session, summary, date) {
  const lines = progress.split(/\r?\n/u);
  // 限定在当前书的区块内查找，避免跨书误匹配同名的分段（例如两本书都有 S7）
  const bookHeading = `## ${session.bookName}`;
  const bookStart = lines.findIndex((line) => line.trim() === bookHeading);
  if (bookStart < 0) throw new Error(`学习进度缺少图书区块：${session.bookName}`);
  const nextHeading = lines
    .slice(bookStart + 1)
    .findIndex((line) => /^## /u.test(line.trim()));
  const bookEnd = nextHeading < 0 ? lines.length : bookStart + 1 + nextHeading;
  const bookLines = lines.slice(bookStart, bookEnd);
  const escapedId = session.segmentId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const currentPattern = new RegExp(`^- \\[ \\] ${escapedId}(?=[（：|\\s])`, "u");
  const localIndex = bookLines.findIndex((line) => currentPattern.test(line));
  if (localIndex < 0) throw new Error(`分段计划没有未完成的 ${session.segmentId}`);
  const currentIndex = bookStart + localIndex;
  const partial = Boolean(session.remainingStartAnchor);
  let nextSegment;
  if (partial) {
    lines[currentIndex] = withPlanAnchors(lines[currentIndex]
      .replace(/(\|\s*~?)\d+(\s*词)/u, `$1${session.remainingWords}$2`)
      .replace(/(\|\s*起\s*["“]).*?(["”]\s*止)/u, `$1${shortAnchor(session.remainingStartAnchor)}$2`),
    session.remainingStartAnchor,
    session.actualEndAnchor);
    nextSegment = {
      ...runtime.state.books[session.bookId].nextSegment,
      plannedWords: session.remainingWords,
      measuredWords: session.remainingWords,
      start: shortAnchor(session.remainingStartAnchor),
      startAnchor: session.remainingStartAnchor,
    };
  } else {
    lines[currentIndex] = `${lines[currentIndex].replace("- [ ]", "- [x]")}（${date} 完成）`;
    const nextLine = lines.slice(currentIndex + 1, bookEnd).find((line) => /^- \[ \] /u.test(line));
    nextSegment = nextLine ? parsePlanLine(nextLine) : null;
    if (nextLine && !nextSegment) throw new Error("下一分段计划无法解析，拒绝推进");
  }

  let updated = lines.join("\n");
  const completionLabel = partial
    ? `Ch${session.chapterNumber}-${session.segmentId}（部分，已费曼）`
    : `Ch${session.chapterNumber}-${session.segmentId}（已费曼）✅`;
  updated = replaceBookField(updated, session.bookName, "上次完成", completionLabel);
  updated = replaceBookField(updated, session.bookName, "上次日期", date);
  const cadence = advanceCadence(runtime.state, session.sessionType);
  updated = replaceGlobalField(updated, "普通阅读场计数", cadence.normalReadingCount);
  const nextSessionLabel = cadence.nextSession === "mixed"
    || cadence.nextSession === "mixed_pending"
    || cadence.nextSession === "heavy_pending"
    ? "回译待输出"
    : "普通阅读场";
  updated = replaceGlobalField(updated, "下次场次", nextSessionLabel);
  updated = insertExpressionRow(updated, session, summary, date);
  const readingSpeed = readingSpeedOf(session);
  return {
    progress: updated,
    nextSegment,
    cadence: readingSpeed === null
      ? cadence
      : { ...cadence, readingWordsPerMinute: readingSpeed },
    partial,
  };
}

function renderNote(session, summary, date, noteTitle) {
  const cleanedSummary = stripNoteTitle(summary)
    .replace(/^\*\*?本结果尚未写入 Obsidian。\*\*?\s*$/gmu, "")
    .replace(/^本结果将在本轮结束时由程序尝试写入真实 Obsidian，最终以存档状态提示为准。\s*$/gmu, "")
    .trim();
  return [
    `# ${noteTitle}`,
    "",
    `**书籍：** ${session.bookName}`,
    `**章节：** Ch${session.chapterNumber} ${session.chapterTitle}`,
    `**分段：** ${session.segmentId}`,
    `**日期：** ${date}`,
    `**范围：** "${session.startAnchor}" 至 "${session.actualEndAnchor}"`,
    `**阅读词数：** ~${session.sourceWords}`,
    "",
    cleanedSummary,
    "",
  ].join("\n");
}

async function assertChapterUnchanged(session, chapterPath) {
  const current = await stat(chapterPath);
  const expected = session.chapterSnapshot;
  const sameSize = current.size === expected.size;
  const sameTime = Math.abs(current.mtimeMs - Date.parse(expected.lastWriteTimeUtc)) < 1000;
  if (!sameSize || !sameTime) throw new Error("章节文件在学习场开始后发生变化，拒绝自动存档");
}

async function assertProgressCurrent(runtime, progressPath) {
  const current = await stat(progressPath);
  const expected = runtime.state.sourceSnapshot;
  const sameSize = current.size === expected.size;
  const sameTime = Math.abs(current.mtimeMs - Date.parse(expected.lastWriteTimeUtc)) < 1000;
  if (!sameSize || !sameTime) throw new Error("学习进度在本轮存档前发生变化，拒绝自动写入");
}

async function createBackup(runtime, session, files) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupRoot = path.join(runtime.runtimeRoot, "backups", `${stamp}-${session.id.slice(0, 8)}`);
  await mkdir(backupRoot, { recursive: true });
  const manifest = [];
  for (const [label, source] of Object.entries(files)) {
    const target = path.join(backupRoot, label);
    await copyFile(source, target);
    const text = await readFile(source, "utf8");
    manifest.push({ label, source, sha256: hashText(text) });
  }
  await writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return backupRoot;
}

export async function prepareRealReading(runtime, session) {
  if (runtime.config.sandbox === true) return { real: false };
  assertRealWrite(runtime);
  const chapterPath = chapterPathFor(runtime, session.bookId);
  const original = await readFile(chapterPath, "utf8");
  const marked = insertReadingMarkers(original, session.startAnchor, session.actualEndAnchor);
  if (marked !== original) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backupRoot = path.join(runtime.runtimeRoot, "backups", `${stamp}-${session.id.slice(0, 8)}-start`);
    await mkdir(backupRoot, { recursive: true });
    await copyFile(chapterPath, path.join(backupRoot, "chapter.md"));
    await atomicWrite(chapterPath, marked);
  }
  const chapterStat = await stat(chapterPath);
  return {
    real: true,
    chapterPath,
    chapterSnapshot: {
      size: chapterStat.size,
      lastWriteTimeUtc: chapterStat.mtime.toISOString(),
    },
  };
}

export async function finalizeRealSession(runtime, session, summaryText, noteTitle) {
  if (runtime.config.sandbox === true) return { real: false };
  if (session.demo === true) {
    // 演示场：不写入任何 Obsidian 文件
    return {
      real: false,
      demo: true,
      notePath: null,
      backupRoot: null,
      nextSegmentId: null,
    };
  }
  assertRealWrite(runtime);
  if (!summaryText.trim()) throw new Error("核对结果为空，未执行真实存档");

  const progressPath = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, runtime.config.progressFile),
    "学习进度",
  );
  const chapterPath = chapterPathFor(runtime, session.bookId);
  const statePath = path.join(runtime.runtimeRoot, "state.json");
  const resolvedNoteTitle = normalizeNoteTitle(noteTitle ?? extractNoteTitle(summaryText));
  const noteSuffix = session.remainingStartAnchor ? `-部分-${session.id.slice(0, 8)}` : "";
  const notePath = assertWithin(
    runtime.config.vaultRoot,
    path.join(bookNotesRoot(runtime, session.bookId), `Ch${session.chapterNumber}-${session.segmentId}${noteSuffix}-${resolvedNoteTitle}.md`),
    "费曼笔记",
  );
  try {
    await stat(notePath);
    throw new Error(`费曼笔记已存在，拒绝覆盖：${notePath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertChapterUnchanged(session, chapterPath);
  await assertProgressCurrent(runtime, progressPath);

  const originals = {
    progress: await readFile(progressPath, "utf8"),
    chapter: await readFile(chapterPath, "utf8"),
    state: await readFile(statePath, "utf8"),
  };
  const liveState = JSON.parse(originals.state);
  if (liveState.books?.[session.bookId]?.nextSegment?.id !== session.segmentId) {
    throw new Error("结构化状态已经指向另一分段，拒绝用旧场次存档");
  }
  const date = new Date().toISOString().slice(0, 10);
  const update = updateProgress(originals.progress, runtime, session, summaryText, date);
  if (!update.partial && update.nextSegment) {
    assertNoNarrativeGap(originals.chapter, session.actualEndAnchor, update.nextSegment.startAnchor);
  }
  let nextChapter = null;
  let progressed = update.progress;
  if (!update.nextSegment) {
    nextChapter = await findNextChapter(runtime, session.bookId);
    if (nextChapter) {
      progressed = advanceProgressFields(update.progress, session.bookName, nextChapter);
    }
  }
  const cleanedChapter = removeReadingMarkers(originals.chapter);
  let fixedSegment = null;
  let nextChapterText = cleanedChapter;
  if (update.nextSegment) {
    try {
      nextChapterText = insertReadingMarkers(cleanedChapter, update.nextSegment.startAnchor, update.nextSegment.endAnchor);
    } catch (error) {
      // 旧的手动规划可能把锚点截断在行中间：自动扩展到段落边界后重试
      const fixedStart = expandAnchorToBoundary(cleanedChapter, update.nextSegment.startAnchor, { fromStart: true });
      const fixedEnd = expandAnchorToBoundary(cleanedChapter, update.nextSegment.endAnchor, { fromStart: false });
      if (fixedStart === update.nextSegment.startAnchor && fixedEnd === update.nextSegment.endAnchor) {
        // 锚点（可能含 … 缩写）在章节中找不到：降级为不插入章节标记，但正常完成存档。
        // 阅读标记只是定位提示；进度、笔记、state 仍照常推进。
        console.warn(`[rto] 跳过下一段章节标记（锚点不可定位）：${update.nextSegment.id} ${error.message}`);
      } else {
        const retried = {
          ...update.nextSegment,
          startAnchor: fixedStart,
          endAnchor: fixedEnd,
          start: shortAnchor(fixedStart),
          end: shortAnchor(fixedEnd),
        };
        // 锚点范围变了，重算实际词数并同步到状态与进度行
        const startIdx = cleanedChapter.indexOf(fixedStart);
        const endIdx = cleanedChapter.indexOf(fixedEnd, startIdx);
        const fixedWords = endIdx >= startIdx
          ? cleanedChapter.slice(startIdx, endIdx + fixedEnd.length).trim().split(/\s+/u).filter(Boolean).length
          : retried.plannedWords;
        retried.plannedWords = fixedWords;
        retried.measuredWords = fixedWords;
        nextChapterText = insertReadingMarkers(cleanedChapter, retried.startAnchor, retried.endAnchor);
        fixedSegment = retried;
        progressed = fixPlanLine(progressed, retried);
      }
    }
  }
  const effectiveSegment = fixedSegment ?? update.nextSegment;
  const bookState = runtime.state.books[session.bookId];
  const nextState = {
    ...runtime.state,
    generatedAt: new Date().toISOString(),
    lastBookId: session.bookId,
    cadence: update.cadence,
    books: {
      ...runtime.state.books,
      [session.bookId]: {
        ...bookState,
        lastCompleted: update.partial
          ? `Ch${session.chapterNumber}-${session.segmentId}（部分）`
          : `Ch${session.chapterNumber}-${session.segmentId}`,
        lastActivityDate: date,
        phase: effectiveSegment
          ? "ready_to_read"
          : nextChapter
            ? "needs_plan"
            : "chapter_complete",
        nextSegment: effectiveSegment,
        ...(nextChapter
          ? {
              chapterNumber: nextChapter.chapterNumber,
              chapterTitle: nextChapter.chapterTitle,
              chapterFile: nextChapter.chapterFile,
            }
          : {}),
      },
    },
  };

  const backupRoot = await createBackup(runtime, session, {
    "progress.md": progressPath,
    "chapter.md": chapterPath,
    "state.json": statePath,
  });
  let noteCreated = false;
  try {
    await atomicWrite(notePath, renderNote(session, summaryText, date, resolvedNoteTitle));
    noteCreated = true;
    await atomicWrite(progressPath, progressed);
    await atomicWrite(chapterPath, nextChapterText);
    const progressStat = await stat(progressPath);
    nextState.sourceSnapshot = {
      size: progressStat.size,
      lastWriteTimeUtc: progressStat.mtime.toISOString(),
    };
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  } catch (error) {
    await atomicWrite(progressPath, originals.progress);
    await atomicWrite(chapterPath, originals.chapter);
    const restoredProgressStat = await stat(progressPath);
    liveState.sourceSnapshot = {
      size: restoredProgressStat.size,
      lastWriteTimeUtc: restoredProgressStat.mtime.toISOString(),
    };
    await atomicWrite(statePath, `${JSON.stringify(liveState, null, 2)}\n`);
    if (noteCreated) await unlink(notePath).catch(() => {});
    throw new Error(`真实存档失败，已回滚：${error.message}`);
  }
  return {
    real: true,
    notePath,
    noteTitle: resolvedNoteTitle,
    backupRoot,
    nextSegmentId: update.nextSegment?.id ?? null,
    ...(nextChapter
      ? {
          advancedTo: {
            chapterNumber: nextChapter.chapterNumber,
            chapterTitle: nextChapter.chapterTitle,
          },
        }
      : {}),
  };
}

/**
 * 用户明确表示已经读完、但选择不做费曼时的收口入口。
 * 不创建费曼笔记、不更新表达力或回译节奏，只推进计划和章节状态。
 */
export async function completeRealSegmentWithoutFeynman(runtime, bookId, {
  completionNote = "手动完成，跳过费曼",
  lastCompletedNote = "已读，跳过费曼",
} = {}) {
  if (runtime.config.sandbox === true) throw new Error("沙盒不支持手动完成真实阅读分段");
  assertRealWrite(runtime);
  const book = runtime.state.books[bookId];
  const segment = book?.nextSegment;
  if (!book || !segment) throw new Error("当前书没有可手动完成的分段");

  const progressPath = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, runtime.config.progressFile),
    "学习进度",
  );
  const chapterPath = chapterPathFor(runtime, bookId);
  const statePath = path.join(runtime.runtimeRoot, "state.json");
  const originals = {
    progress: await readFile(progressPath, "utf8"),
    chapter: await readFile(chapterPath, "utf8"),
    state: await readFile(statePath, "utf8"),
  };
  const liveState = JSON.parse(originals.state);
  if (liveState.books?.[bookId]?.nextSegment?.id !== segment.id) {
    throw new Error("结构化状态已经指向另一分段，拒绝手动完成旧分段");
  }

  const lines = originals.progress.split(/\r?\n/u);
  const bookConfig = runtime.config.books.find((item) => item.id === bookId);
  const bookName = bookConfig?.name;
  const bookStart = lines.findIndex((line) => line.trim() === `## ${bookName}`);
  if (bookStart < 0) throw new Error(`学习进度缺少图书区块：${bookName}`);
  const nextHeading = lines.slice(bookStart + 1).findIndex((line) => /^## /u.test(line.trim()));
  const bookEnd = nextHeading < 0 ? lines.length : bookStart + 1 + nextHeading;
  const escapedId = segment.id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const lineIndex = lines.findIndex((line, index) => (
    index >= bookStart && index < bookEnd && new RegExp(`^- \\[[ x]\\] ${escapedId}(?=[（：|\\s])`, "u").test(line)
  ));
  if (lineIndex < 0) throw new Error(`分段计划找不到 ${segment.id}`);

  const date = new Date().toISOString().slice(0, 10);
  lines[lineIndex] = lines[lineIndex]
    .replace(/^- \[x\] /u, "- [x] ")
    .replace(/^- \[ \] /u, "- [x] ");
  if (!/（\d{4}-\d{2}-\d{2} 完成）/u.test(lines[lineIndex])) {
    lines[lineIndex] = `${lines[lineIndex]}（${date} ${completionNote}）`;
  }
  const nextLine = lines.slice(lineIndex + 1, bookEnd).find((line) => /^- \[ \] /u.test(line));
  const nextSegment = nextLine ? parsePlanLine(nextLine) : null;
  if (nextLine && !nextSegment) throw new Error("下一分段计划无法解析，拒绝推进");
  if (nextSegment) {
    assertNoNarrativeGap(originals.chapter, segment.endAnchor, nextSegment.startAnchor);
  }

  let progressed = lines.join("\n");
  progressed = replaceBookField(progressed, bookName, "上次完成", `Ch${book.chapterNumber}-${segment.id}（${lastCompletedNote}）`);
  progressed = replaceBookField(progressed, bookName, "上次日期", date);
  let nextChapter = null;
  if (!nextSegment) {
    nextChapter = await findNextChapter(runtime, bookId);
    if (nextChapter) progressed = advanceProgressFields(progressed, bookName, nextChapter);
  }

  const cleanedChapter = removeReadingMarkers(originals.chapter);
  let nextChapterText = cleanedChapter;
  if (nextSegment) nextChapterText = insertReadingMarkers(cleanedChapter, nextSegment.startAnchor, nextSegment.endAnchor);
  const nextState = {
    ...liveState,
    generatedAt: new Date().toISOString(),
    lastBookId: bookId,
    books: {
      ...liveState.books,
      [bookId]: {
        ...book,
        lastCompleted: `Ch${book.chapterNumber}-${segment.id}（${lastCompletedNote}）`,
        lastActivityDate: date,
        phase: nextSegment ? "ready_to_read" : nextChapter ? "needs_plan" : "chapter_complete",
        nextSegment,
        ...(nextChapter ? {
          chapterNumber: nextChapter.chapterNumber,
          chapterTitle: nextChapter.chapterTitle,
          chapterFile: nextChapter.chapterFile,
        } : {}),
      },
    },
  };
  const backupRoot = await createBackup(runtime, { id: `manual-${segment.id}` }, {
    "progress.md": progressPath,
    "chapter.md": chapterPath,
    "state.json": statePath,
  });
  try {
    await atomicWrite(progressPath, progressed);
    await atomicWrite(chapterPath, nextChapterText);
    const progressStat = await stat(progressPath);
    nextState.sourceSnapshot = { size: progressStat.size, lastWriteTimeUtc: progressStat.mtime.toISOString() };
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  } catch (error) {
    await atomicWrite(progressPath, originals.progress);
    await atomicWrite(chapterPath, originals.chapter);
    await atomicWrite(statePath, originals.state);
    throw new Error(`手动完成失败，已回滚：${error.message}`);
  }
  return {
    real: true,
    completedSegmentId: segment.id,
    nextSegmentId: nextSegment?.id ?? null,
    advancedTo: nextChapter ?? null,
    backupRoot,
  };
}
