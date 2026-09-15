import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, removeReadingMarkers } from "./sandbox.js";
import { normalizeBacktranslationMode } from "./cadence.js";
import { readablePlanAnchor, withPlanAnchors } from "./plan-metadata.js";

const TARGET_WORDS_PER_SEGMENT = 650;
const MIN_SEGMENTS = 2;
const ANCHOR_FORBIDDEN = /["“”]/u;

function assertWithin(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 不在允许目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

function countOccurrences(text, needle) {
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = text.indexOf(needle, cursor);
    if (found === -1) return count;
    count += 1;
    cursor = found + needle.length;
  }
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function isNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^!\[\[.*\]\]$/u.test(trimmed)) return true;
  if (/^FIGURE\s+\d/iu.test(trimmed)) return true;
  if (/^\d+\s+The\s+/u.test(trimmed)) return true;
  if (/^#\s+Chapter\s+\d+/iu.test(trimmed)) return true;
  if (/^\d+$/u.test(trimmed)) return true;
  return false;
}

function splitChapterBlocks(lines) {
  const blocks = [];
  let current = [];
  let currentStart = 0;
  const flush = (end) => {
    if (current.length) {
      blocks.push({ lines: current, startLine: currentStart, endLine: end - 1 });
      current = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") {
      flush(index);
    } else {
      if (!current.length) currentStart = index;
      current.push(lines[index]);
    }
  }
  flush(lines.length);
  return blocks;
}

function safeAnchorLine(lines, fromEnd = false) {
  const ordered = fromEnd ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const trimmed = line.trim();
    if (!trimmed || isNoiseLine(trimmed) || ANCHOR_FORBIDDEN.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function findUniqueAnchor(text, allLines, startLine, endLine, fromEnd) {
  const slice = allLines.slice(startLine, endLine + 1);
  const edge = fromEnd ? slice.length - 1 : 0;
  const step = fromEnd ? -1 : 1;
  for (let index = edge; index >= 0 && index < slice.length; index += step) {
    const line = slice[index].trim();
    if (!line || isNoiseLine(line)) continue;
    const cut = line.search(ANCHOR_FORBIDDEN);
    const candidateLine = cut < 0 ? line : (fromEnd ? line.slice(cut + 1).trim() : line.slice(0, cut).trim());
    if (!candidateLine || ANCHOR_FORBIDDEN.test(candidateLine)) continue;
    const sentences = candidateLine.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu) ?? [candidateLine];
    const candidates = fromEnd ? [...sentences].reverse() : sentences;
    for (const candidate of candidates.map((item) => item.trim()).filter(Boolean)) {
      if (countOccurrences(text, candidate) === 1) return candidate;
    }
  }
  return null;
}

function segmentLinesFor(allLines, blocks, startIndex, endIndexExclusive) {
  const first = blocks[startIndex];
  const last = blocks[endIndexExclusive - 1];
  return allLines.slice(first.startLine, last.endLine + 1);
}

function chooseCutPoints(blocks, targetCount) {
  const words = blocks.map((block) => countWords(block.lines.join(" ")));
  const totalWords = words.reduce((sum, value) => sum + value, 0);
  if (blocks.length <= 1 || totalWords <= 0) return [blocks.length];
  const targetWords = Math.max(1, totalWords / targetCount);
  const cuts = [];
  let acc = 0;
  for (let index = 0; index < blocks.length - 1; index += 1) {
    acc += words[index];
    if (acc >= targetWords && cuts.length < targetCount - 1) {
      cuts.push(index + 1);
      acc = 0;
    }
  }
  return [...new Set([...cuts, blocks.length])];
}

function headingOf(block) {
  const heading = block.lines.find((line) => /^#{1,4}\s+/u.test(line.trim()));
  return heading ? heading.trim().replace(/^#{1,4}\s+/u, "") : "";
}

export function buildSegmentPlan(chapterText, cadence) {
  const allLines = chapterText.split(/\r?\n/u);
  const blocks = splitChapterBlocks(allLines);
  const totalWords = countWords(chapterText);
  // 过短章节降级为单段，保证任何导入的书都能开始读
  if (totalWords < 80) {
    const lines = allLines.filter((line) => !isNoiseLine(line));
    const startAnchor = findUniqueAnchor(chapterText, allLines, 0, allLines.length - 1, false);
    const endAnchor = findUniqueAnchor(chapterText, allLines, 0, allLines.length - 1, true);
    if (!startAnchor || !endAnchor) {
      throw new Error("章节过短且找不到可用锚点，请检查章节格式");
    }
    return [{
      id: "S1",
      sessionType: "ordinary",
      plannedWords: totalWords,
      measuredWords: totalWords,
      start: shortAnchor(startAnchor),
      end: shortAnchor(endAnchor),
      startAnchor,
      endAnchor,
      heading: headingOf(blocks[0] ?? { lines }) || "",
    }];
  }

  const targetCount = Math.max(
    MIN_SEGMENTS,
    Math.min(blocks.length, Math.ceil(totalWords / TARGET_WORDS_PER_SEGMENT)),
  );
  const cuts = chooseCutPoints(blocks, targetCount);
  let normalCount = cadence.normalReadingCount ?? 0;
  const useMixedSessions = normalizeBacktranslationMode(cadence.backtranslationMode) === "light";

  const segments = [];
  let startBlock = 0;
  for (let index = 0; index < cuts.length; index += 1) {
    const endBlock = cuts[index];
    const lines = segmentLinesFor(allLines, blocks, startBlock, endBlock);
    const startLine = blocks[startBlock].startLine;
    const endLine = blocks[endBlock - 1].endLine;
    const startAnchor = findUniqueAnchor(chapterText, allLines, startLine, endLine, false);
    const endAnchor = findUniqueAnchor(chapterText, allLines, startLine, endLine, true);
    if (!startAnchor || !endAnchor) {
      throw new Error(`第 ${index + 1} 段找不到唯一锚点，请手动规划或检查章节格式`);
    }
    if (chapterText.indexOf(endAnchor) < chapterText.indexOf(startAnchor)) {
      throw new Error(`第 ${index + 1} 段终点位于起点之前，请检查章节格式`);
    }
    const mixed = useMixedSessions && normalCount >= 2;
    const sessionType = mixed ? "mixed" : "ordinary";
    if (mixed) normalCount = 0;
    else normalCount += 1;

    const startIdx = chapterText.indexOf(startAnchor);
    const endIdx = chapterText.indexOf(endAnchor, startIdx);
    const words = countWords(chapterText.slice(startIdx, endIdx + endAnchor.length));
    const heading = headingOf(blocks[startBlock]) || headingOf({ lines }) || "";
    segments.push({
      id: `S${index + 1}`,
      sessionType,
      plannedWords: words,
      measuredWords: words,
      start: shortAnchor(startAnchor),
      end: shortAnchor(endAnchor),
      startAnchor,
      endAnchor,
      heading,
    });
    startBlock = endBlock;
  }
  return segments;
}

function shortAnchor(anchor) {
  return anchor.length > 110 ? `${anchor.slice(0, 107).trimEnd()}...` : anchor;
}

function renderPlanBlock(segments, chapterNumber, chapterTitle) {
  const lines = [
    "",
    `### 分段计划：Ch${chapterNumber} ${chapterTitle}`,
    "",
  ];
  for (const segment of segments) {
    const mark = segment.sessionType === "mixed" ? "（混合场）" : "";
    const description = segment.heading
      ? `：${segment.heading.replace(/[:：|]/gu, "／").slice(0, 40)}`
      : "";
    lines.push(withPlanAnchors(
      `- [ ] ${segment.id}${mark}${description} | ~${segment.plannedWords} 词 | 起 "${readablePlanAnchor(segment.startAnchor)}" 止 "${readablePlanAnchor(segment.endAnchor, { fromEnd: true })}"`,
      segment.startAnchor,
      segment.endAnchor,
    ));
  }
  lines.push("");
  return lines.join("\n");
}

function replacePlanBlock(progress, bookName, chapterNumber, chapterTitle, segments) {
  const heading = `## ${bookName}`;
  const start = progress.indexOf(heading);
  if (start < 0) throw new Error(`学习进度缺少图书区块：${bookName}`);
  const end = progress.indexOf("\n## ", start + heading.length);
  const boundary = end < 0 ? progress.length : end;
  const section = progress.slice(start, boundary);
  const withoutOldPlan = section.replace(
    /\r?\n\s*### 分段计划：[^\r\n]*\r?\n[\s\S]*?(?=\r?\n## |\s*$)/u,
    "",
  );
  const block = renderPlanBlock(segments, chapterNumber, chapterTitle);
  return `${progress.slice(0, start)}${withoutOldPlan}${block}${progress.slice(boundary)}`;
}

export async function planChapterSegments(runtime, bookId) {
  const book = runtime.state.books[bookId];
  if (!book) throw new Error(`缺少图书状态：${bookId}`);
  const bookConfig = runtime.config.books.find((item) => item.id === bookId);
  if (!bookConfig) throw new Error(`缺少图书配置：${bookId}`);

  const chapterPath = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, book.chapterFile),
    "章节文件",
  );
  if (path.extname(chapterPath).toLowerCase() !== ".md") throw new Error("章节文件必须是 Markdown");
  const chapterText = await readFile(chapterPath, "utf8");
  const segments = buildSegmentPlan(chapterText, runtime.state.cadence);

  if (runtime.config.sandbox === true) {
    return planSandboxSegments(runtime, bookId, book, segments, chapterPath);
  }
  return planRealSegments(runtime, bookId, book, bookConfig, segments, chapterPath);
}

async function planSandboxSegments(runtime, bookId, book, segments, chapterPath) {
  const statePath = path.join(runtime.runtimeRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const nextSegment = segments[0];
  const nextState = {
    ...state,
    generatedAt: new Date().toISOString(),
    books: {
      ...state.books,
      [bookId]: {
        ...book,
        phase: "ready_to_read",
        currentSegmentIndex: 0,
        completedSegments: [],
        segments,
        nextSegment,
      },
    },
  };
  await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  return {
    sandbox: true,
    segments,
    nextSegmentId: nextSegment.id,
    phase: "ready_to_read",
  };
}

async function planRealSegments(runtime, bookId, book, bookConfig, segments, chapterPath) {
  if (runtime.config.writeMode !== "real") {
    throw new Error("自动分段计划需要 config.writeMode 显式设为 real");
  }
  if (runtime.freshness.status !== "current") {
    throw new Error(`拒绝规划：${runtime.freshness.reason}`);
  }
  const progressPath = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, runtime.config.progressFile),
    "学习进度",
  );
  const statePath = path.join(runtime.runtimeRoot, "state.json");

  const originals = {
    progress: await readFile(progressPath, "utf8"),
    state: await readFile(statePath, "utf8"),
  };
  const planned = replacePlanBlock(
    originals.progress,
    bookConfig.name,
    book.chapterNumber,
    book.chapterTitle,
    segments,
  );
  const nextSegment = segments[0];
  const nextState = {
    ...runtime.state,
    generatedAt: new Date().toISOString(),
    books: {
      ...runtime.state.books,
      [bookId]: {
        ...book,
        phase: "ready_to_read",
        nextSegment,
      },
    },
  };

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupRoot = path.join(runtime.runtimeRoot, "backups", `${stamp}-${bookId}-plan`);
  await mkdir(backupRoot, { recursive: true });
  const backupFiles = {
    "progress.md": progressPath,
    "chapter.md": chapterPath,
    "state.json": statePath,
  };
  const manifest = [];
  for (const [label, source] of Object.entries(backupFiles)) {
    await copyFile(source, path.join(backupRoot, label));
    manifest.push({ label, source, sha256: createHash("sha256").update(await readFile(source, "utf8"), "utf8").digest("hex") });
  }
  await writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  try {
    await atomicWrite(progressPath, planned);
    const progressStat = await stat(progressPath);
    nextState.sourceSnapshot = {
      size: progressStat.size,
      lastWriteTimeUtc: progressStat.mtime.toISOString(),
    };
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  } catch (error) {
    await atomicWrite(progressPath, originals.progress);
    await atomicWrite(statePath, originals.state);
    throw new Error(`分段计划写入失败，已回滚：${error.message}`);
  }
  return {
    real: true,
    segments,
    nextSegmentId: nextSegment.id,
    phase: "ready_to_read",
    backupRoot,
  };
}

export function planBlockPreview(segments) {
  return segments.map((segment) => (
    `${segment.id}${segment.sessionType === "mixed" ? "（混合场）" : ""}｜约 ${segment.plannedWords} 词｜${segment.heading || "章节开头"}`
  ));
}
