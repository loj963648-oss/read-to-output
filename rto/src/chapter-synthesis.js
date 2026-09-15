import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./sandbox.js";
import { bookNotesRoot } from "./book-storage.js";

const PROMPT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.read-to-output/prompts",
);

function assertWithin(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relation = path.relative(resolvedRoot, resolvedTarget);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 不在允许目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

export function chapterNotePattern(chapterNumber) {
  return new RegExp(`^Ch${chapterNumber}-(?!章节串联-)`, "u");
}

async function readMatchingNotes(notesRoot, chapterNumber, { filter } = {}) {
  let entries;
  try {
    entries = await readdir(notesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && chapterNotePattern(chapterNumber).test(entry.name) && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const notes = [];
  for (const file of files) {
    try {
      const text = await readFile(path.join(notesRoot, file.name), "utf8");
      if (!filter || filter(text)) notes.push({ file: file.name, text });
    } catch {
      // 单个笔记读取失败时跳过，不影响其他笔记
    }
  }
  return notes;
}

function belongsToLegacyBook(text, book) {
  const explicitBook = text.match(/^\*\*书籍：\*\*\s*(.+?)\s*$/mu)?.[1];
  if (explicitBook) return explicitBook === book.bookName;
  const explicitChapter = text.match(/^\*\*章节：\*\*\s*Ch\d+\s+(.+?)\s*$/mu)?.[1];
  return Boolean(book.chapterTitle && explicitChapter === book.chapterTitle);
}

export async function collectChapterNotes(runtime, book) {
  if (!book?.bookId || !book?.chapterNumber) {
    throw new Error("收集章节笔记需要 bookId 和 chapterNumber");
  }
  const scopedRoot = assertWithin(
    runtime.config.vaultRoot,
    bookNotesRoot(runtime, book.bookId),
    "图书费曼笔记目录",
  );
  const legacyRoot = assertWithin(
    runtime.config.vaultRoot,
    path.join(runtime.config.vaultRoot, "费曼笔记"),
    "旧版费曼笔记目录",
  );
  const scoped = await readMatchingNotes(scopedRoot, book.chapterNumber);
  const legacy = await readMatchingNotes(legacyRoot, book.chapterNumber, {
    filter: (text) => belongsToLegacyBook(text, book),
  });
  return [...scoped, ...legacy].sort((left, right) => left.file.localeCompare(right.file));
}

export function buildSynthesisContext(bookName, chapterNumber, chapterTitle, notes) {
  return [
    `<chapter_notes book="${bookName}" chapter="${chapterNumber}" title="${chapterTitle}">`,
    notes.length
      ? notes.map((note) => `<note file="${note.file}">\n${note.text.trim()}\n</note>`).join("\n\n")
      : "（本章还没有费曼笔记）",
    "</chapter_notes>",
  ].join("\n");
}

export async function generateChapterSynthesis(ctx, runtime, { bookName, chapterNumber, chapterTitle }, notes) {
  if (!ctx.model || typeof ctx.modelRegistry?.complete !== "function") {
    throw new Error("synthesis-unavailable");
  }
  const prompt = await readFile(path.join(PROMPT_DIRECTORY, "chapter-synthesis.md"), "utf8");
  const response = await ctx.modelRegistry.complete(
    ctx.model,
    {
      systemPrompt: prompt,
      messages: [{
        role: "user",
        content: buildSynthesisContext(bookName, chapterNumber, chapterTitle, notes),
        timestamp: Date.now(),
      }],
      tools: [],
    },
    {
      maxTokens: 1500,
      temperature: 0,
      signal: ctx.signal,
    },
  );
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function saveChapterSynthesis(runtime, bookId, chapterNumber, content) {
  if (!content) throw new Error("章节串联内容为空");
  const notesRoot = assertWithin(
    runtime.config.vaultRoot,
    bookNotesRoot(runtime, bookId),
    "图书费曼笔记目录",
  );
  await mkdir(notesRoot, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const target = path.join(notesRoot, `Ch${chapterNumber}-章节串联-${date}.md`);
  await atomicWrite(target, `${content.trim()}\n`);
  return target;
}

export async function synthesizeChapter(ctx, runtime, book, notes) {
  const content = await generateChapterSynthesis(
    ctx,
    runtime,
    {
      bookName: book.bookName,
      chapterNumber: book.chapterNumber,
      chapterTitle: book.chapterTitle,
    },
    notes,
  );
  return saveChapterSynthesis(runtime, book.bookId, book.chapterNumber, content);
}
