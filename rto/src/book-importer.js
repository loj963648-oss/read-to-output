import { mkdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "./sandbox.js";
import { parseEpub, parseTxt } from "./book-parser.js";

function slugify(name) {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned || `Book-${randomUUID().slice(0, 8)}`;
}

function chapterFileName(chapterNumber, title) {
  const slug = slugify(title).slice(0, 60);
  return `Ch${String(chapterNumber).padStart(2, "0")}-${slug}.md`;
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

function renderChapterMarkdown(title, text) {
  const lines = text.split(/\r?\n/u);
  const hasHeading = lines.some((line) => /^#\s+/u.test(line.trim()));
  return [
    hasHeading ? "" : `# ${title}`,
    "",
    text.trim(),
    "",
  ].join("\n");
}

function renderProgressBookSection(bookName, chapterNumber, chapterTitle, chapterFile) {
  return [
    `## ${bookName}`,
    "",
    `- 当前章节：第 ${chapterNumber} 章（${chapterTitle}）🚧 待规划`,
    `- 章节文件：\`${chapterFile}\``,
    `- 上次完成：尚未开始`,
    `- 上次日期：${new Date().toISOString().slice(0, 10)}`,
    "",
  ].join("\n");
}

async function prepareProgressUpdate(runtime, book) {
  if (!runtime.config.progressFile) return null;
  const progressPath = path.join(runtime.config.vaultRoot, runtime.config.progressFile);
  let progress = "";
  let existed = true;
  try {
    progress = await readFile(progressPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") existed = false;
    else throw error;
  }
  const heading = `## ${book.name}`;
  if (progress.includes(heading)) {
    throw new Error(`学习进度已存在同名图书区块：${book.name}`);
  }
  const section = renderProgressBookSection(
    book.name,
    book.chapterNumber,
    book.chapterTitle,
    book.chapterFile,
  );
  return {
    path: progressPath,
    existed,
    original: progress,
    updated: `${progress.trimEnd()}\n\n${section}\n`,
  };
}

async function assertMissing(target, message) {
  try {
    await stat(target);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/**
 * 导入一本书：解析电子书文件 → 在 Obsidian 库建目录 → 按章写入 md → 注册到 config/state。
 * 返回 { bookId, bookName, chapterDirectory, chapterCount, firstChapterFile }。
 */
export async function importBook(runtime, { filePath, bookName, chapterNumber = 1, chapterTitle = "Introduction" }) {
  const resolvedFile = path.resolve(filePath);
  const extension = path.extname(resolvedFile).toLowerCase();
  if (![".epub", ".txt"].includes(extension)) {
    throw new Error("仅支持 EPUB 和 TXT 电子书（当前：" + extension + "）");
  }
  const raw = await readFile(resolvedFile);
  let parsed;
  if (extension === ".epub") {
    parsed = parseEpub(raw);
  } else {
    parsed = parseTxt(raw.toString("utf8"), bookName);
  }
  const finalName = bookName?.trim() || parsed.title || path.basename(resolvedFile, extension);
  const directoryName = slugify(finalName);
  const chapterDirectory = `${directoryName}/Chapters`;
  const bookRoot = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, directoryName),
    "图书目录",
  );

  const bookId = slugify(finalName).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-").replace(/^-+|-+$/gu, "")
    || `book-${randomUUID().slice(0, 8)}`;
  const chapters = parsed.chapters.map((chapter, index) => ({
    number: chapterNumber + index,
    title: chapter.title,
    file: path.join(chapterDirectory, chapterFileName(chapterNumber + index, chapter.title)).replace(/\\/gu, "/"),
    text: chapter.text,
  }));
  if (!chapters.length) throw new Error("电子书中没有可导入的章节");

  const configPath = path.join(runtime.runtimeRoot, "config.json");
  const statePath = path.join(runtime.runtimeRoot, "state.json");
  const originalConfigText = await readFile(configPath, "utf8");
  const originalStateText = await readFile(statePath, "utf8");
  const config = JSON.parse(originalConfigText);
  const state = JSON.parse(originalStateText);
  if (!Array.isArray(config.books)) throw new Error("config.books 必须是数组");
  if (config.books.some((book) => book.id === bookId || book.name === finalName)) {
    throw new Error(`已存在同名图书：${finalName}（${bookId}）`);
  }
  if (state.books?.[bookId]) {
    throw new Error(`结构化状态已存在同名图书：${finalName}（${bookId}）`);
  }
  await assertMissing(bookRoot, `Obsidian 中已存在同名图书目录，拒绝覆盖：${bookRoot}`);

  const firstChapter = chapters[0];
  const progressUpdate = await prepareProgressUpdate(runtime, {
    name: finalName,
    chapterNumber,
    chapterTitle: firstChapter.title,
    chapterFile: firstChapter.file,
  });
  const stagingRoot = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, `.rto-import-${randomUUID()}`),
    "导入暂存目录",
  );
  const stagingChapterRoot = path.join(stagingRoot, "Chapters");
  await mkdir(stagingChapterRoot, { recursive: true });

  try {
    for (const chapter of chapters) {
      const target = path.join(stagingChapterRoot, path.basename(chapter.file));
      await atomicWrite(target, renderChapterMarkdown(chapter.title, chapter.text));
    }
    await rename(stagingRoot, bookRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(`图书章节导入失败，未修改学习状态：${error.message}`);
  }

  const now = new Date().toISOString();
  let progressSnapshot = state.sourceSnapshot ?? null;
  const nextConfig = {
    ...config,
    books: [...config.books, { id: bookId, name: finalName, chapterDirectory }],
  };
  const nextState = {
    ...state,
    generatedAt: now,
    sourceSnapshot: progressSnapshot,
    lastBookId: bookId,
    books: {
      ...state.books,
      [bookId]: {
        chapterNumber: chapterNumber,
        chapterTitle: firstChapter.title,
        chapterFile: firstChapter.file,
        lastCompleted: "尚未开始",
        lastActivityDate: now.slice(0, 10),
        phase: "needs_plan",
        nextSegment: null,
      },
    },
  };
  try {
    if (progressUpdate) {
      await atomicWrite(progressUpdate.path, progressUpdate.updated);
      const refreshedProgressStat = await stat(progressUpdate.path);
      progressSnapshot = {
        size: refreshedProgressStat.size,
        lastWriteTimeUtc: refreshedProgressStat.mtime.toISOString(),
      };
      nextState.sourceSnapshot = progressSnapshot;
    }
    await atomicWrite(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    await atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  } catch (error) {
    await atomicWrite(configPath, originalConfigText).catch(() => {});
    if (progressUpdate) {
      if (progressUpdate.existed) await atomicWrite(progressUpdate.path, progressUpdate.original).catch(() => {});
      else await unlink(progressUpdate.path).catch(() => {});
    }
    const restoredState = JSON.parse(originalStateText);
    if (progressUpdate?.existed) {
      try {
        const restoredProgressStat = await stat(progressUpdate.path);
        restoredState.sourceSnapshot = {
          size: restoredProgressStat.size,
          lastWriteTimeUtc: restoredProgressStat.mtime.toISOString(),
        };
      } catch {
        // 进度文件恢复失败时仍优先恢复原始 state 内容
      }
    }
    await atomicWrite(statePath, `${JSON.stringify(restoredState, null, 2)}\n`).catch(() => {});
    await rm(bookRoot, { recursive: true, force: true }).catch(() => {});
    throw new Error(`图书注册失败，已回滚章节和学习状态：${error.message}`);
  }
  return {
    bookId,
    bookName: finalName,
    chapterDirectory,
    chapterCount: chapters.length,
    firstChapterFile: firstChapter.file,
  };
}
