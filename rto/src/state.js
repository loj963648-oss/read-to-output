import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveAnchor } from "./anchor-resolution.js";

const RUNTIME_DIRECTORIES = new Set([".read-to-output", ".read-to-output-sandbox"]);

export function getRuntimeDirectoryName() {
  const directory = process.env.RTO_RUNTIME_DIRECTORY?.trim() || ".read-to-output";
  if (!RUNTIME_DIRECTORIES.has(directory)) {
    throw new Error(`不允许的运行目录：${directory}`);
  }
  return directory;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
}

function resolveWithin(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error(`${label} 路径缺失`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const relation = path.relative(resolvedRoot, resolvedPath);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 超出了 Obsidian 库：${relativePath}`);
  }
  return resolvedPath;
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export async function loadRuntime(projectRoot) {
  const runtimeRoot = path.join(projectRoot, getRuntimeDirectoryName());
  const configPath = path.join(runtimeRoot, "config.json");
  const statePath = path.join(runtimeRoot, "state.json");
  const [configText, stateText] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(statePath, "utf8"),
  ]);

  const parsedConfig = parseJson(configText, "config.json");
  const state = parseJson(stateText, "state.json");
  assertObject(parsedConfig, "config.json");
  assertObject(state, "state.json");
  assertObject(state.books, "state.books");

  if (parsedConfig.version !== 1 || state.version !== 1) {
    throw new Error("暂不支持此配置或状态文件版本");
  }
  if (!Array.isArray(parsedConfig.books)) {
    throw new Error("config.books 必须是数组");
  }

  const config = {
    ...parsedConfig,
    vaultRoot: path.isAbsolute(parsedConfig.vaultRoot)
      ? parsedConfig.vaultRoot
      : path.resolve(projectRoot, parsedConfig.vaultRoot),
  };

  const progressPath = resolveWithin(config.vaultRoot, config.progressFile, "学习进度");
  let freshness = { status: "unknown", reason: "无法读取学习进度文件元数据" };
  try {
    const progressStat = await stat(progressPath);
    const expected = state.sourceSnapshot ?? {};
    const sameSize = progressStat.size === expected.size;
    const expectedTime = Date.parse(expected.lastWriteTimeUtc ?? "");
    const sameTime = Number.isFinite(expectedTime) && Math.abs(progressStat.mtimeMs - expectedTime) < 1000;
    freshness = config.sandbox || (sameSize && sameTime)
      ? { status: "current", reason: "结构化状态与学习进度快照一致" }
      : {
          status: "stale",
          reason: "学习进度.md 已变化；只读原型不会自行猜测新进度",
          actual: { size: progressStat.size, lastWriteTimeUtc: progressStat.mtime.toISOString() },
        };
  } catch (error) {
    freshness = { status: "missing", reason: `无法读取学习进度.md：${error.message}` };
  }

  return {
    projectRoot,
    runtimeRoot,
    config,
    state,
    freshness,
    metrics: {
      configBytes: Buffer.byteLength(configText, "utf8"),
      stateBytes: Buffer.byteLength(stateText, "utf8"),
      totalRuntimeBytes: Buffer.byteLength(configText, "utf8") + Buffer.byteLength(stateText, "utf8"),
      chapterContentRead: false,
      progressContentRead: false,
    },
  };
}

export function buildDashboard(runtime) {
  const books = runtime.config.books.map((bookConfig) => {
    const bookState = runtime.state.books[bookConfig.id];
    if (!bookState) {
      throw new Error(`state.json 缺少图书状态：${bookConfig.id}`);
    }

    const nextSegment = bookState.nextSegment ?? null;
    const summary = nextSegment
      ? `第${bookState.chapterNumber}章，下一段 ${nextSegment.id}`
      : `第${bookState.chapterNumber}章，待自动规划分段`;

    return {
      id: bookConfig.id,
      name: bookConfig.name,
      summary,
      isLastBook: bookConfig.id === runtime.state.lastBookId,
      ...bookState,
    };
  });

  return {
    books,
    lastBookId: runtime.state.lastBookId,
    cadence: runtime.state.cadence,
    freshness: runtime.freshness,
    metrics: runtime.metrics,
  };
}

export function findBook(dashboard, query) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) {
    return dashboard.books.find((book) => book.id === dashboard.lastBookId) ?? dashboard.books[0];
  }

  const exact = dashboard.books.find(
    (book) => book.id.toLocaleLowerCase("zh-CN") === normalized || book.name.toLocaleLowerCase("zh-CN") === normalized,
  );
  if (exact) return exact;

  const matches = dashboard.books.filter(
    (book) =>
      book.id.toLocaleLowerCase("zh-CN").includes(normalized) ||
      book.name.toLocaleLowerCase("zh-CN").includes(normalized),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function renderBookCard(book, dashboard) {
  const lines = [
    `Read-to-Output｜${book.name}`,
    `当前：第${book.chapterNumber}章 ${book.chapterTitle}`,
  ];

  if (book.nextSegment) {
    const segment = book.nextSegment;
    const sessionLabel = segment.sessionType === "mixed" ? "混合场" : "普通阅读场";
    lines.push(`下一步：阅读 ${segment.id}（${sessionLabel}，约 ${segment.measuredWords ?? segment.plannedWords} 词）`);
    lines.push(`起点：${segment.start}`);
    lines.push(`终点：${segment.end}`);
  } else {
    lines.push("下一步：开始时选择“按分段”或“按时间”");
  }

  lines.push(`状态读取：${dashboard.metrics.totalRuntimeBytes} bytes；未读取学习进度正文或章节正文`);
  if (dashboard.freshness.status !== "current") {
    lines.push(`⚠ ${dashboard.freshness.reason}`);
  }
  return lines;
}

export async function extractCurrentSegment(runtime, bookId) {
  const bookConfig = runtime.config.books.find((book) => book.id === bookId);
  const bookState = runtime.state.books[bookId];
  if (!bookConfig || !bookState) throw new Error(`找不到图书：${bookId}`);
  if (!bookState.nextSegment) throw new Error(`${bookConfig.name} 当前没有可读取的分段`);

  const chapterPath = resolveWithin(runtime.config.vaultRoot, bookState.chapterFile, "章节文件");
  const chapterText = await readFile(chapterPath, "utf8");
  const { startAnchor, endAnchor } = bookState.nextSegment;
  const start = resolveAnchor(chapterText, startAnchor);
  const end = resolveAnchor(chapterText, endAnchor);
  if (start.count !== 1 || end.count !== 1) {
    throw new Error(`分段锚点不唯一：起点 ${start.count} 个，终点 ${end.count} 个`);
  }

  const startIndex = chapterText.indexOf(start.anchor);
  const endIndex = chapterText.indexOf(end.anchor, startIndex);
  if (endIndex < startIndex) throw new Error("终点位于起点之前");
  const text = chapterText.slice(startIndex, endIndex + end.anchor.length);

  return {
    bookId,
    chapterPath,
    segmentId: bookState.nextSegment.id,
    text,
    characters: text.length,
    words: countWords(text),
    startOccurrences: start.count,
    endOccurrences: end.count,
  };
}
