import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractCurrentSegment, getRuntimeDirectoryName } from "./state.js";

const SESSION_FILE = "active-session.json";
const LAST_VERIFIED_SESSION_FILE = "last-verified-session.json";
const VALID_PHASES = new Set(["reading", "scope", "feynman", "verify", "verified"]);
const PROMPT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.read-to-output/prompts",
);
const PROMPT_FILES = {
  scope: "scope-check.md",
  feynman: "feynman-student.md",
  verify: "verify-summary.md",
};

function sessionPath(projectRoot) {
  return path.join(projectRoot, getRuntimeDirectoryName(), SESSION_FILE);
}

function lastVerifiedSessionPath(projectRoot) {
  return path.join(projectRoot, getRuntimeDirectoryName(), LAST_VERIFIED_SESSION_FILE);
}

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function trimToWordBudget(text, targetWords) {
  if (countWords(text) <= targetWords) return text;
  const boundaries = [...text.matchAll(/\r?\n\s*\r?\n/gu)]
    .map((match) => match.index)
    .filter((index) => index > 0);
  if (!boundaries.length) return text;

  const candidates = boundaries
    .map((index) => ({ text: text.slice(0, index).trimEnd() }))
    .map((candidate) => ({ ...candidate, words: countWords(candidate.text) }))
    .filter((candidate) => candidate.words >= 80);
  if (!candidates.length) return text;
  return candidates.reduce((best, candidate) => (
    Math.abs(candidate.words - targetWords) < Math.abs(best.words - targetWords)
      ? candidate
      : best
  )).text;
}

function finalLine(text) {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = text.indexOf(needle, cursor);
    if (found === -1) return count;
    count += 1;
    cursor = found + needle.length;
  }
}

function isSandboxSession(session) {
  return session.sandbox === true
    || (session.sandbox === undefined && getRuntimeDirectoryName() === ".read-to-output-sandbox");
}

function validateSession(session) {
  if (!session || typeof session !== "object" || session.version !== 1) {
    throw new Error("active-session.json 格式无效");
  }
  if (!VALID_PHASES.has(session.phase)) {
    throw new Error(`未知学习阶段：${session.phase}`);
  }
  if (typeof session.sourceText !== "string" || !session.sourceText.trim()) {
    throw new Error("当前学习场缺少实际已读原文");
  }
  if (hashText(session.sourceText) !== session.sourceHash) {
    throw new Error("当前学习场的原文缓存校验失败");
  }
  if (!Number.isInteger(session.studentTurnsUsed) || session.studentTurnsUsed < 0) {
    session.studentTurnsUsed = 0;
  }
  if (session.scopeExplanation !== undefined && typeof session.scopeExplanation !== "string") {
    throw new Error("当前学习场的讲述缓存格式无效");
  }
  if (session.feynmanUserTurns === undefined) session.feynmanUserTurns = [];
  if (!Array.isArray(session.feynmanUserTurns)
    || session.feynmanUserTurns.some((turn) => typeof turn !== "string")) {
    throw new Error("当前学习场的费曼回答缓存格式无效");
  }
  if (session.feynmanDialogue === undefined) session.feynmanDialogue = [];
  if (!Array.isArray(session.feynmanDialogue)
    || session.feynmanDialogue.some((turn) => !turn
      || !["assistant", "user"].includes(turn.role)
      || typeof turn.text !== "string")) {
    throw new Error("当前学习场的费曼对话缓存格式无效");
  }
  if (session.accumulatedReadingMs === undefined) session.accumulatedReadingMs = 0;
  if (!Number.isFinite(session.accumulatedReadingMs) || session.accumulatedReadingMs < 0) {
    throw new Error("当前学习场的阅读计时无效");
  }
  return session;
}

export async function readActiveSession(projectRoot) {
  try {
    const text = await readFile(sessionPath(projectRoot), "utf8");
    return validateSession(JSON.parse(text));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`active-session.json 不是有效 JSON：${error.message}`);
    throw error;
  }
}

export async function writeActiveSession(projectRoot, session) {
  validateSession(session);
  const runtimeRoot = path.join(projectRoot, getRuntimeDirectoryName());
  await mkdir(runtimeRoot, { recursive: true });
  const target = sessionPath(projectRoot);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return session;
}

export async function readLastVerifiedSession(projectRoot) {
  try {
    const session = validateSession(JSON.parse(await readFile(lastVerifiedSessionPath(projectRoot), "utf8")));
    if (session.phase !== "verified" || !session.archivedAt) {
      throw new Error("最近完成场快照尚未核对并存档");
    }
    return session;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeLastVerifiedSession(projectRoot, session) {
  validateSession(session);
  if (session.phase !== "verified" || !session.archivedAt) {
    throw new Error("只能保存已经核对并存档的学习场快照");
  }
  const runtimeRoot = path.join(projectRoot, getRuntimeDirectoryName());
  await mkdir(runtimeRoot, { recursive: true });
  const target = lastVerifiedSessionPath(projectRoot);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return session;
}

function extractMarkedSource(chapter) {
  const match = chapter.match(/^\s*%%起点%%\s*\r?\n([\s\S]*?)\r?\n\s*%%终点%%\s*$/mu);
  return match?.[1]?.trim() || null;
}

export async function recoverLastVerifiedSessionFromBackups(runtime) {
  const backupRoot = path.join(runtime.runtimeRoot, "backups");
  let directories;
  try {
    directories = (await readdir(backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const directory of directories) {
    const candidateRoot = path.join(backupRoot, directory);
    try {
      const [chapter, stateText] = await Promise.all([
        readFile(path.join(candidateRoot, "chapter.md"), "utf8"),
        readFile(path.join(candidateRoot, "state.json"), "utf8"),
      ]);
      const sourceText = extractMarkedSource(chapter);
      if (!sourceText) continue;
      const state = JSON.parse(stateText);
      const bookId = state.lastBookId;
      const book = state.books?.[bookId];
      const segment = book?.nextSegment;
      const bookConfig = runtime.config.books?.find((item) => item.id === bookId);
      if (!book || !segment || !bookConfig) continue;
      const recovered = {
        version: 1,
        id: randomUUID(),
        sandbox: runtime.config.sandbox === true,
        phase: "verified",
        archivedAt: new Date().toISOString(),
        recoveredFromBackup: directory,
        bookId,
        bookName: bookConfig.name,
        chapterNumber: book.chapterNumber,
        chapterTitle: book.chapterTitle,
        segmentId: segment.id,
        sessionType: segment.sessionType ?? "ordinary",
        startAnchor: segment.startAnchor,
        plannedEndAnchor: segment.endAnchor,
        actualEndAnchor: segment.endAnchor,
        sourceText,
        sourceHash: hashText(sourceText),
        sourceWords: countWords(sourceText),
        sourceCharacters: sourceText.length,
        studentTurnsUsed: 0,
        scopeExplanation: "",
        feynmanUserTurns: [],
        feynmanDialogue: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return writeLastVerifiedSession(runtime.projectRoot, recovered);
    } catch (error) {
      if (["ENOENT", "SyntaxError"].includes(error.code) || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}

export async function startReadingSession(runtime, bookId, planning = {}) {
  if (runtime.freshness.status !== "current") {
    throw new Error(runtime.freshness.reason);
  }

  const segment = await extractCurrentSegment(runtime, bookId);
  const chapterStat = await stat(segment.chapterPath);
  const bookState = runtime.state.books[bookId];
  const bookConfig = runtime.config.books.find((book) => book.id === bookId);
  const planningMode = planning.mode === "time" ? "time" : "segment";
  const totalMinutes = planningMode === "time" ? Number(planning.totalMinutes) : null;
  if (planningMode === "time"
    && (!Number.isInteger(totalMinutes) || totalMinutes < 10 || totalMinutes > 240)) {
    throw new Error("时间规划需要 10–240 分钟的整数总时长");
  }
  const reservedMinutes = planningMode === "time"
    ? (bookState.nextSegment.sessionType === "mixed" ? 25 : 15)
    : null;
  const readingMinutes = planningMode === "time"
    ? Math.max(5, totalMinutes - reservedMinutes)
    : null;
  const targetWords = planningMode === "time"
    ? Math.max(100, Math.round((runtime.state.cadence?.readingWordsPerMinute ?? 700 / 30) * readingMinutes))
    : null;
  const mixedSegment = bookState.nextSegment.sessionType === "mixed";
  const backtranslationMode = runtime.state.cadence?.backtranslationMode ?? "light";
  const shortenForMixed = backtranslationMode === "light" && mixedSegment;
  const sourceText = planningMode === "time"
    ? trimToWordBudget(segment.text, targetWords)
    : shortenForMixed
      ? trimToWordBudget(segment.text, Math.round(segment.words * 0.65))
      : segment.text;
  const remainderText = segment.text.slice(sourceText.length).trim();
  const remainingStartAnchor = remainderText
    ? remainderText.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
    : null;
  const actualEndAnchor = sourceText === segment.text
    ? bookState.nextSegment.endAnchor
    : finalLine(sourceText);
  const now = new Date().toISOString();
  const session = {
    version: 1,
    id: randomUUID(),
    sandbox: runtime.config.sandbox === true,
    phase: "reading",
    bookId,
    bookName: bookConfig.name,
    chapterNumber: bookState.chapterNumber,
    chapterTitle: bookState.chapterTitle,
    segmentId: segment.segmentId,
    sessionType: bookState.nextSegment.sessionType ?? "ordinary",
    planningMode,
    totalMinutes,
    estimatedReadingMinutes: readingMinutes,
    startAnchor: bookState.nextSegment.startAnchor,
    plannedEndAnchor: bookState.nextSegment.endAnchor,
    actualEndAnchor,
    sourceText,
    sourceHash: hashText(sourceText),
    sourceWords: countWords(sourceText),
    sourceCharacters: sourceText.length,
    fullSourceWords: segment.words,
    remainingWords: remainderText ? countWords(remainderText) : 0,
    remainingStartAnchor,
    studentTurnsUsed: 0,
    scopeExplanation: "",
    feynmanUserTurns: [],
    feynmanDialogue: [],
    testExplanation: runtime.config.sandbox ? bookState.nextSegment.testExplanation ?? "" : "",
    testAnswers: runtime.config.sandbox ? bookState.nextSegment.testAnswers ?? [] : [],
    chapterSnapshot: {
      size: chapterStat.size,
      lastWriteTimeUtc: chapterStat.mtime.toISOString(),
    },
    accumulatedReadingMs: 0,
    lastResumeAt: now,
    startedAt: now,
    updatedAt: now,
  };
  return writeActiveSession(runtime.projectRoot, session);
}

export async function assertSessionSourceCurrent(runtime, session) {
  validateSession(session);
  if (session.demo === true) return session;
  const planned = await extractCurrentSegment(runtime, session.bookId);
  if (planned.segmentId !== session.segmentId) {
    throw new Error("结构化进度已经指向另一分段，请不要继续旧学习场");
  }
  if (!planned.text.startsWith(session.sourceText)) {
    throw new Error("章节原文或本段边界已经变化，请重新开始本段");
  }
  return session;
}

export async function trimSessionAtEnd(runtime, endFragment) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session) throw new Error("当前没有进行中的学习场");
  if (session.phase !== "reading") throw new Error("只有阅读阶段可以修改实际终点");
  const fragment = endFragment.trim();
  if (!fragment) throw new Error("请在 /learn stop 后粘贴实际读到的末句片段");

  await assertSessionSourceCurrent(runtime, session);
  const occurrences = countOccurrences(session.sourceText, fragment);
  if (occurrences !== 1) {
    throw new Error(`实际终点必须在本段中唯一出现；当前找到 ${occurrences} 处`);
  }
  const endIndex = session.sourceText.indexOf(fragment) + fragment.length;
  const sourceText = session.sourceText.slice(0, endIndex);
  const updated = {
    ...session,
    actualEndAnchor: fragment,
    sourceText,
    sourceHash: hashText(sourceText),
    sourceWords: countWords(sourceText),
    sourceCharacters: sourceText.length,
    updatedAt: new Date().toISOString(),
  };
  return writeActiveSession(runtime.projectRoot, updated);
}

export async function resumeReadingTimer(projectRoot) {
  const session = await readActiveSession(projectRoot);
  if (!session || session.phase !== "reading") return session;
  // 每次进程启动都是一轮新的阅读：重置计时起点。
  // 上次进程内已经结算的时间保留在 accumulatedReadingMs；
  // 未结算部分（直接退出）不补偿，关闭期间的时间不计入。
  return writeActiveSession(projectRoot, {
    ...session,
    lastResumeAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * 撤回上一步阶段推进（误按快捷键 / 误发推进指令时使用）。
 * 允许的逆向：scope → reading、feynman → scope、verify → feynman。
 * reading 和 verified 不可撤回。
 */
export async function regressSession(runtime) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session) throw new Error("当前没有进行中的学习场");
  const previous = {
    scope: "reading",
    feynman: "scope",
    verify: "feynman",
  }[session.phase];
  if (!previous) throw new Error(`当前阶段（${session.phase}）无法撤回`);
  const now = new Date().toISOString();
  if (previous === "reading") {
    // 撤回阅读：重新开始计时（阅读结算在进入 scope 时已发生）
    return writeActiveSession(runtime.projectRoot, {
      ...session,
      phase: "reading",
      lastResumeAt: now,
      updatedAt: now,
    });
  }
  if (previous === "scope") {
    // 撤回范围确认：清空费曼阶段数据，保留用户讲述（scopeExplanation）
    return writeActiveSession(runtime.projectRoot, {
      ...session,
      phase: "scope",
      studentTurnsUsed: 0,
      feynmanUserTurns: [],
      feynmanDialogue: [],
      updatedAt: now,
    });
  }
  // feynman ← verify：保留讲述与追问记录，回到费曼可继续补充
  return writeActiveSession(runtime.projectRoot, {
    ...session,
    phase: "feynman",
    updatedAt: now,
  });
}

export async function transitionSession(runtime, nextPhase) {
  if (!VALID_PHASES.has(nextPhase)) throw new Error(`未知学习阶段：${nextPhase}`);
  const session = await readActiveSession(runtime.projectRoot);
  if (!session) throw new Error("当前没有进行中的学习场，请先用 /learn start 开始阅读");
  if (session.phase === nextPhase) {
    await assertSessionSourceCurrent(runtime, session);
    return session;
  }

  const allowed = {
    reading: new Set(["scope"]),
    scope: new Set(["feynman"]),
    feynman: new Set(["verify"]),
    verify: new Set(["verified"]),
    verified: new Set(["verify"]),
  };
  if (!allowed[session.phase].has(nextPhase)) {
    throw new Error(`不能从 ${session.phase} 直接切换到 ${nextPhase}`);
  }

  await assertSessionSourceCurrent(runtime, session);
  let next = { ...session, phase: nextPhase };
  if (session.phase === "reading" && nextPhase === "scope") {
    // 阅读计时结算：只累计真实阅读时间，跨会话关闭期间不计入
    const now = new Date();
    const resumeAt = session.lastResumeAt ? Date.parse(session.lastResumeAt) : Date.parse(session.startedAt);
    const elapsedMs = Math.max(0, now.getTime() - resumeAt);
    next = {
      ...next,
      accumulatedReadingMs: session.accumulatedReadingMs + elapsedMs,
      lastResumeAt: null,
    };
  }
  return writeActiveSession(runtime.projectRoot, {
    ...next,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordStudentTurn(runtime, question = "") {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session || session.phase !== "feynman") return session;
  const text = question.trim();
  return writeActiveSession(runtime.projectRoot, {
    ...session,
    studentTurnsUsed: Math.min(3, session.studentTurnsUsed + 1),
    feynmanDialogue: text
      ? [...session.feynmanDialogue, { role: "assistant", text }]
      : session.feynmanDialogue,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordScopeExplanation(runtime, explanation) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session || session.phase !== "scope") return session;
  const scopeExplanation = explanation.trim();
  if (!scopeExplanation || scopeExplanation.startsWith("/")) return session;
  return writeActiveSession(runtime.projectRoot, {
    ...session,
    scopeExplanation,
    updatedAt: new Date().toISOString(),
  });
}

export async function recordFeynmanUserTurn(runtime, explanation) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session || session.phase !== "feynman") return session;
  const turn = explanation.trim();
  if (!turn || turn.startsWith("/")) return session;
  return writeActiveSession(runtime.projectRoot, {
    ...session,
    feynmanUserTurns: [...session.feynmanUserTurns, turn],
    feynmanDialogue: [...session.feynmanDialogue, { role: "user", text: turn }],
    updatedAt: new Date().toISOString(),
  });
}

export async function recordPreparedChapterSnapshot(runtime, chapterSnapshot) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session || session.phase !== "reading") return session;
  if (!chapterSnapshot?.size || !chapterSnapshot?.lastWriteTimeUtc) {
    throw new Error("准备后的章节快照无效");
  }
  return writeActiveSession(runtime.projectRoot, {
    ...session,
    chapterSnapshot,
    updatedAt: new Date().toISOString(),
  });
}

export async function markSessionArchived(runtime, archiveResult) {
  const session = await readActiveSession(runtime.projectRoot);
  if (!session || session.phase !== "verified") throw new Error("当前没有可标记为已存档的学习场");
  const archived = await writeActiveSession(runtime.projectRoot, {
    ...session,
    archivedAt: new Date().toISOString(),
    archiveResult,
    updatedAt: new Date().toISOString(),
  });
  await writeLastVerifiedSession(runtime.projectRoot, archived);
  return archived;
}

export function parseScopeDecision(text) {
  const firstLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const hasIn = /^(?:\[?RTO_SCOPE(?:_|:)IN\]?|<!--RTO_SCOPE:IN-->)$/u.test(firstLine)
    || text.includes("<!--RTO_SCOPE:IN-->");
  const hasOut = /^(?:\[?RTO_SCOPE(?:_|:)OUT\]?|<!--RTO_SCOPE:OUT-->)$/u.test(firstLine)
    || text.includes("<!--RTO_SCOPE:OUT-->")
    || text.includes("你讲的内容似乎不属于当前分段")
    || text.includes("讲述范围与当前分段不匹配");
  if (hasIn === hasOut) return null;
  return hasIn ? "in" : "out";
}

export function stripScopeDecisionMarker(text) {
  return text
    .replace(/^\s*\[?RTO_SCOPE(?:_|:)(?:IN|OUT)\]?\s*(?:\r?\n|$)/u, "")
    .replace(/\s*<!--RTO_SCOPE:(?:IN|OUT)-->\s*/gu, "\n")
    .trim();
}

export function isScopeInOverride(text) {
  return /^(这是当前段|就是当前段|确认属于当前段|范围正确)[。！! ]*$/u.test(text.trim());
}

export function renderSessionCard(session) {
  const sandboxSession = isSandboxSession(session);
  const archived = Boolean(session.archivedAt) || sandboxSession;
  const phaseNames = {
    reading: "阅读中",
    scope: "讲述范围核验",
    feynman: "费曼讲述",
    verify: "原文核对中",
    verified: archived
      ? sandboxSession
        ? "核对完成（已写入测试沙盒）"
        : "核对完成（已写入真实 Obsidian）"
      : sandboxSession
        ? "核对完成（待写入测试沙盒）"
        : "核对完成（待写入真实 Obsidian）",
  };
  return [
    `Read-to-Output｜${session.bookName}`,
    `当前：第${session.chapterNumber}章 ${session.chapterTitle}`,
    `分段：${session.segmentId}｜${session.sourceWords} 词`,
    session.planningMode === "time"
      ? `规划：按时间（总计 ${session.totalMinutes} 分钟，预计阅读 ${session.estimatedReadingMinutes} 分钟）`
      : "规划：按章节分段",
    `起点：${session.startAnchor ?? session.sourceText.split(/\r?\n/u).find(Boolean)}`,
    `终点：${session.actualEndAnchor}`,
    `阶段：${phaseNames[session.phase]}`,
    ...(session.phase === "feynman" ? [`学生回应轮次：${session.studentTurnsUsed}/3`] : []),
  ];
}

export function isVerificationRequest(text) {
  const command = text.trim().replace(/^[、，,。；;：:！!？?\s]+/u, "");
  return /^(总结|总结吧|总结一下|你来总结|帮我总结|开始核对|核对吧|请总结|现在总结|重新总结|重新核对)[。！! ]*$/u.test(command);
}

export function isFeynmanCompletionRequest(text) {
  if (isVerificationRequest(text)) return true;
  const command = text.trim().replace(/^[、，,。；;：:！!？?\s]+/u, "");
  return /^(没有了|没了|没有补充(?:了)?|没(?:有|什么)补充(?:了)?|就这些|就这样|可以总结(?:了)?|你总结吧|来总结吧|我讲完了|讲完了|我讲好了|讲好了)[。！! ]*$/u.test(command);
}

function buildRecordedLearningProcess(session) {
  const dialogue = session.feynmanDialogue.length
    ? session.feynmanDialogue
      .map((turn, index) => `${index + 1}. ${turn.role === "assistant" ? "学生问题" : "用户回答"}：${turn.text}`)
      .join("\n")
    : "（无已保存的逐轮对话）";
  const assistantTurnsRecorded = session.feynmanDialogue
    .filter((turn) => turn.role === "assistant").length;
  const historyStatus = assistantTurnsRecorded < session.studentTurnsUsed ? "partial" : "complete";
  return [
    `<recorded_learning_process history_status="${historyStatus}" student_turns_used="${session.studentTurnsUsed}" assistant_turns_recorded="${assistantTurnsRecorded}">`,
    "<initial_user_explanation>",
    session.scopeExplanation?.trim() || "（未保存）",
    "</initial_user_explanation>",
    "<feynman_dialogue>",
    dialogue,
    "</feynman_dialogue>",
    historyStatus === "partial"
      ? "<history_warning>旧版本未完整保存逐轮问答。不得据此声称用户没有被追问；只能说明过程记录不完整。</history_warning>"
      : "",
    "</recorded_learning_process>",
  ].filter(Boolean).join("\n");
}

export async function buildPhaseSystemPrompt(_basePrompt, session, phase, { realWrite = false } = {}) {
  validateSession(session);
  const promptFile = PROMPT_FILES[phase];
  if (!promptFile) return _basePrompt;
  let rules = await readFile(path.join(PROMPT_DIRECTORY, promptFile), "utf8");
  if (phase === "verify" && isSandboxSession(session)) {
    rules = rules.replace(
      /本结果尚未写入 Obsidian。/gu,
      "本结果仅写入测试沙盒，不会写入真实 Obsidian。",
    );
  } else if (phase === "verify" && realWrite) {
    rules = rules.replace(
      /本结果尚未写入 Obsidian。/gu,
      "本结果将在本轮结束时由程序尝试写入真实 Obsidian，最终以存档状态提示为准。",
    );
  }
  const source = [
    `<actual_read_source book="${session.bookName}" chapter="${session.chapterNumber}" segment="${session.segmentId}">`,
    session.sourceText,
    "</actual_read_source>",
  ].join("\n");

  if (phase === "scope") {
    return [SYSTEM_IDENTITY, source, rules.trim()].join("\n\n");
  }

  const runtimeControl = phase === "feynman"
    ? `<runtime_control student_turns_used="${session.studentTurnsUsed}" max_student_turns="3">\n${
        session.studentTurnsUsed >= 3
          ? "已达到上限：禁止提出新问题，只询问用户是否补充或开始总结。"
          : `还可进行 ${3 - session.studentTurnsUsed} 个学生回应轮次。`
      }\n</runtime_control>`
    : "";
  const finalGate = phase === "feynman"
    ? "<mandatory_gate>回答前再次确认：问题必须同时来自用户讲述并属于 actual_read_source；否则只报告范围不匹配。</mandatory_gate>"
    : "";
  const learningProcess = ["feynman", "verify"].includes(phase)
    ? buildRecordedLearningProcess(session)
    : "";
  return [SYSTEM_IDENTITY, rules.trim(), source, learningProcess, runtimeControl, finalGate]
    .filter(Boolean)
    .join("\n\n");
}

const SYSTEM_IDENTITY = "你是 Read-to-Output 垂直学习 Agent。只执行当前学习阶段，不承担编程、搜索或其他通用助手任务。";
