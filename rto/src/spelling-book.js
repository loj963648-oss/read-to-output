import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./sandbox.js";

const HISTORY_FILE = "spelling-history.json";
const MIN_WORD_LENGTH = 4;
const MAX_EDIT_DISTANCE = 2;
const RECORD_THRESHOLD = 2; // 同一词第 2 次拼错才写入单词本

export function spellingHistoryPath(runtime) {
  return path.join(runtime.runtimeRoot, HISTORY_FILE);
}

function emptyHistory() {
  return { version: 1, items: [] };
}

function validateHistory(history) {
  if (!history || typeof history !== "object" || history.version !== 1) {
    throw new Error("spelling-history.json 格式无效");
  }
  if (!Array.isArray(history.items)) throw new Error("spelling-history.json 缺少 items 数组");
  return history;
}

export async function readSpellingHistory(runtime) {
  try {
    return validateHistory(JSON.parse(await readFile(spellingHistoryPath(runtime), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyHistory();
    throw error;
  }
}

async function saveHistory(runtime, history) {
  await atomicWrite(spellingHistoryPath(runtime), `${JSON.stringify(history, null, 2)}\n`);
  return history;
}

function normalizeWord(word) {
  return word
    .toLowerCase()
    .replace(/^[^a-z]+/u, "")
    .replace(/[^a-z]+$/u, "")
    .trim();
}

function levenshtein(left, right) {
  const a = left.length;
  const b = right.length;
  const matrix = Array.from({ length: a + 1 }, (_, i) => [i, ...Array(b).fill(0)]);
  for (let j = 0; j <= b; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a; i += 1) {
    for (let j = 1; j <= b; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
  }
  return matrix[a][b];
}

/**
 * 比较用户答案与参考英文，找出“拼写接近但不同”的词对。
 * 只收：小写词、长度 >= 4、编辑距离 <= 2、参考词集中存在。
 * 不收：一次性手误（由调用方用历史判断）、未提供英文的专名（首字母大写词被 normalize 前排除）。
 */
export function detectSpellingIssues(userAnswer, referenceEn) {
  const referenceWords = new Set(
    referenceEn
      .split(/[^a-zA-Z]+/u)
      .filter((word) => word.length >= MIN_WORD_LENGTH && /^[a-z]/.test(word))
      .map((word) => word.toLowerCase()),
  );
  const issues = [];
  const seen = new Set();
  for (const raw of userAnswer.split(/[^a-zA-Z]+/u)) {
    if (raw.length < MIN_WORD_LENGTH || /^[A-Z]/.test(raw)) continue; // 排除专名
    const word = normalizeWord(raw);
    if (!word || seen.has(word) || referenceWords.has(word)) continue;
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of referenceWords) {
      if (Math.abs(candidate.length - word.length) > MAX_EDIT_DISTANCE) continue;
      const distance = levenshtein(word, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (best && bestDistance <= MAX_EDIT_DISTANCE) {
      seen.add(word);
      issues.push({ wrong: word, correct: best });
    }
  }
  return issues;
}

export function confirmSpellingIssues(issues, feedbackText) {
  if (!issues.length) return [];
  const feedback = String(feedbackText ?? "").toLowerCase();
  if (!feedback.trim()) return [];
  const explicitlyAboutSpelling = /拼写|拼错|错拼|spelling|misspell/iu.test(feedback);
  return issues.filter((issue) => (
    explicitlyAboutSpelling
    || (feedback.includes(issue.wrong) && feedback.includes(issue.correct))
  ));
}

export function advanceSpellingHistory(history, issues) {
  const items = [...history.items];
  const records = [];
  for (const issue of issues) {
    const index = items.findIndex((item) => item.word === issue.wrong);
    const now = new Date().toISOString();
    if (index < 0) {
      items.push({ word: issue.wrong, correct: issue.correct, count: 1, firstSeen: now, lastSeen: now });
    } else {
      items[index] = {
        ...items[index],
        correct: issue.correct,
        count: items[index].count + 1,
        lastSeen: now,
      };
    }
    const updated = items.find((item) => item.word === issue.wrong);
    if (updated.count >= RECORD_THRESHOLD) records.push(updated);
  }
  return { history: { ...history, items }, records };
}

export function renderSpellingBook(records) {
  const lines = [
    "# 回译错题单词本",
    "",
    "> 只记录稳定拼写缺口：同一词再次拼错或反映稳定词形混淆。一次性手误和题目未提供英文的专名不收。",
    "",
    "| 错误拼写 | 正确拼写 | 出现次数 | 最近出现 |",
    "|---------|---------|---------|---------|",
  ];
  for (const record of records) {
    const lastSeen = record.lastSeen ? record.lastSeen.slice(0, 10) : "—";
    lines.push(`| ${record.word} | ${record.correct} | ${record.count} | ${lastSeen} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function updateSpellingBook(runtime, records) {
  if (!records.length) return null;
  const target = path.join(runtime.config.vaultRoot, "回译错题单词本.md");
  let existing = "";
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tableRows = existing.split(/\r?\n/u)
    .filter((line) => /^\| [a-z]/.test(line) && !/错误拼写/u.test(line));
  const merged = new Map();
  for (const line of tableRows) {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length >= 4 && parts[1]) {
      merged.set(parts[1], { word: parts[1], correct: parts[2], count: Number(parts[3]) || 1 });
    }
  }
  for (const record of records) {
    const existingRecord = merged.get(record.word);
    merged.set(record.word, existingRecord
      ? { ...existingRecord, correct: record.correct, count: Math.max(existingRecord.count, record.count) }
      : record);
  }
  const sorted = [...merged.values()].sort((a, b) => a.word.localeCompare(b.word));
  await atomicWrite(target, renderSpellingBook(sorted));
  return target;
}
