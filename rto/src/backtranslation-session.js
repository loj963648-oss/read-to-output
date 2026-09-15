import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./sandbox.js";
import { getRuntimeDirectoryName } from "./state.js";
import {
  assertBacktranslationRuntime,
  backtranslationQueuePath,
  completeReviewAttempt,
  registerFirstAttempt,
} from "./backtranslation-queue.js";
import { backtranslationWordRange, updateCadenceAfterBacktranslation } from "./cadence.js";
import {
  advanceSpellingHistory,
  confirmSpellingIssues,
  detectSpellingIssues,
  readSpellingHistory,
  spellingHistoryPath,
  updateSpellingBook,
} from "./spelling-book.js";

const OUTPUT_SESSION_FILE = "active-output-session.json";
const VALID_PHASES = new Set(["select", "answer", "correct", "rewrite", "assess", "completed"]);
const MODEL_PHASES = new Set(["select", "correct", "assess"]);
const PROMPT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.read-to-output/prompts",
);
const PROMPT_FILES = {
  select: "backtranslation-select.md",
  correct: "backtranslation-correct.md",
  assess: "backtranslation-assess.md",
  reviewAssess: "backtranslation-review-assess.md",
};

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function sessionPath(projectRoot) {
  return path.join(projectRoot, getRuntimeDirectoryName(), OUTPUT_SESSION_FILE);
}

function validateSession(session) {
  if (!session || typeof session !== "object" || session.version !== 1) {
    throw new Error("active-output-session.json 格式无效");
  }
  if (!VALID_PHASES.has(session.phase)) throw new Error(`未知回译阶段：${session.phase}`);
  if (typeof session.sourceText !== "string" || !session.sourceText.trim()) {
    throw new Error("回译会话缺少已读原文");
  }
  if (hashText(session.sourceText) !== session.sourceHash) {
    throw new Error("回译会话的已读原文校验失败");
  }
  return session;
}

async function saveSession(runtime, session) {
  assertBacktranslationRuntime(runtime);
  const next = { ...session, updatedAt: new Date().toISOString() };
  await atomicWrite(path.join(runtime.runtimeRoot, OUTPUT_SESSION_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function extractMarker(text, name) {
  const pattern = new RegExp(`<!--${name}\\s*([\\s\\S]*?)\\s*${name}-->`, "u");
  const match = text.match(pattern);
  if (!match) throw new Error(`模型没有返回 ${name} 结构化标记`);
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${name} 不是有效 JSON：${error.message}`);
  }
  return {
    data,
    visibleText: text.replace(pattern, "").trim(),
  };
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 缺失`);
  return value.trim();
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 必须是非负整数`);
  return value;
}

export function isBacktranslationRequest(text) {
  return /^(回译|开始回译|继续回译|做回译|回译训练|回译复习|开始复习)[。！! ]*$/u.test(text.trim());
}

export function isBacktranslationModelPhase(phase) {
  return MODEL_PHASES.has(phase);
}

export async function readActiveBacktranslationSession(projectRoot) {
  try {
    return validateSession(JSON.parse(await readFile(sessionPath(projectRoot), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function cancelBacktranslation(runtime) {
  await unlink(path.join(runtime.runtimeRoot, OUTPUT_SESSION_FILE)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function startBacktranslation(runtime, learningSession, options = {}) {
  assertBacktranslationRuntime(runtime);
  if (!learningSession || learningSession.phase !== "verified") {
    throw new Error("请先完成并核对一个阅读分段，再开始回译");
  }
  if (runtime.config.sandbox !== true && !learningSession.archivedAt) {
    throw new Error("最近阅读分段尚未完成正式存档，不能用于回译");
  }
  if (typeof learningSession.sourceText !== "string" || !learningSession.sourceText.trim()) {
    throw new Error("最近学习场没有可用于回译的已读原文");
  }
  if (hashText(learningSession.sourceText) !== learningSession.sourceHash) {
    throw new Error("最近学习场的原文缓存校验失败");
  }

  return saveSession(runtime, {
    version: 1,
    id: randomUUID(),
    kind: "new",
    sandbox: runtime.config.sandbox === true,
    phase: "select",
    bookId: learningSession.bookId,
    bookName: learningSession.bookName,
    chapterNumber: learningSession.chapterNumber,
    chapterTitle: learningSession.chapterTitle,
    segmentId: learningSession.segmentId,
    sourceText: learningSession.sourceText,
    sourceHash: learningSession.sourceHash,
    sourceWords: learningSession.sourceWords,
    outputSlot: options.outputSlot ?? null,
    targetWordRange: backtranslationWordRange(runtime.state?.cadence?.newBacktranslationWords).level,
    excludedSourceTexts: options.excludedSources ?? [],
    excludedSourceHashes: (options.excludedSources ?? []).map(hashText),
    startedAt: new Date().toISOString(),
  });
}

export async function startBacktranslationReview(runtime, item, outputSlot) {
  assertBacktranslationRuntime(runtime);
  const sourceEn = requireText(item.sourceEn, "复习英文原句");
  const promptZh = requireText(item.lockedPromptZh, "锁定中文题目");
  const referenceEn = requireText(item.lockedReferenceEn, "锁定参考英文");
  return saveSession(runtime, {
    version: 1,
    id: randomUUID(),
    kind: "review",
    sandbox: runtime.config.sandbox === true,
    phase: "answer",
    queueItemId: item.id,
    attemptNumber: item.nextAttempt,
    bookId: item.bookId,
    bookName: item.bookName,
    chapterNumber: item.chapterNumber,
    chapterTitle: item.chapterTitle,
    segmentId: item.segmentId,
    sourceText: sourceEn,
    sourceHash: hashText(sourceEn),
    sourceEn,
    sourceEnHash: item.sourceEnHash ?? hashText(sourceEn),
    promptZh,
    rewritePromptZh: promptZh,
    rewriteReferenceEn: referenceEn,
    focus: item.originalFocus,
    correctionFocus: item.correctionFocus,
    errorPatterns: item.errorPatterns ?? [],
    notePath: item.notePath,
    outputSlot,
    startedAt: new Date().toISOString(),
  });
}

export async function buildBacktranslationSystemPrompt(_basePrompt, session) {
  validateSession(session);
  if (!MODEL_PHASES.has(session.phase)) throw new Error(`阶段 ${session.phase} 不需要模型提示词`);
  const promptFile = session.phase === "assess" && session.kind === "review"
    ? PROMPT_FILES.reviewAssess
    : PROMPT_FILES[session.phase];
  const prompt = await readFile(path.join(PROMPT_DIRECTORY, promptFile), "utf8");
  const context = session.phase === "select"
    ? [
        "<selection_length>",
        `本题目标长度：${backtranslationWordRange(session.targetWordRange).level} 词。`,
        `优先选目标范围内的完整连续原文；15 词以上的完整短句仍可接受，最长不得超过 ${backtranslationWordRange(session.targetWordRange).upper} 词。`,
        "</selection_length>",
        "<verified_read_source>",
        session.sourceText,
        "</verified_read_source>",
        ...(session.excludedSourceHashes?.length
          ? [
              "<selection_constraint>",
              "不得重复选择此前已经进入回译队列的英文原句。程序还会再次校验。",
              ...(session.excludedSourceTexts ?? []).map((source) => `- ${source}`),
              "</selection_constraint>",
            ]
          : []),
      ]
    : session.phase === "correct"
      ? [
          "<backtranslation_task>",
          `中文题目：${session.promptZh}`,
          `英文原文：${session.sourceEn}`,
          `用户答案：${session.userAnswer}`,
          "</backtranslation_task>",
        ]
      : session.kind === "review"
        ? [
            "<backtranslation_review>",
            `复习次数：第 ${session.attemptNumber} 次`,
            `锁定中文题目：${session.promptZh}`,
            `锁定参考英文：${session.rewriteReferenceEn}`,
            `本次纠错重点：${session.correctionFocus || session.focus}`,
            `用户答案：${session.userAnswer}`,
            "</backtranslation_review>",
          ]
        : [
            "<backtranslation_rewrite>",
            `锁定中文题目：${session.rewritePromptZh}`,
            `参考英文：${session.rewriteReferenceEn}`,
            `第一次是否通过：${session.firstAttemptPassed}`,
            `主要错误模式：${session.errorPatterns.join("、") || "无"}`,
            `用户重写：${session.userRewrite}`,
            "</backtranslation_rewrite>",
          ];
  return [prompt.trim(), "", ...context].join("\n");
}

export async function recordBacktranslationSelection(runtime, candidateText) {
  const session = await readActiveBacktranslationSession(runtime.projectRoot);
  if (!session || session.phase !== "select") throw new Error("当前不在回译选题阶段");
  const { data } = extractMarker(candidateText, "RTO_BT_SELECTION");
  const sourceEn = requireText(data.sourceEn, "回译英文原句");
  const promptZh = requireText(data.promptZh, "回译中文题目");
  const focus = requireText(data.focus, "回译训练重点");
  if (!session.sourceText.includes(sourceEn)) {
    throw new Error("回译英文原句并非已核对原文中的连续原句");
  }
  const words = countWords(sourceEn);
  const targetRange = backtranslationWordRange(session.targetWordRange);
  if (words < 15 || words > targetRange.upper) {
    throw new Error(`当前档位为 ${targetRange.level} 词；完整短句最少 15 词，最长 ${targetRange.upper} 词，当前 ${words} 词`);
  }
  if (session.excludedSourceHashes?.includes(hashText(sourceEn))) {
    throw new Error("这句英文已经进入回译复习队列，请从本段另选一句");
  }
  const next = await saveSession(runtime, {
    ...session,
    phase: "answer",
    sourceEn,
    promptZh,
    focus,
    sourceEnHash: hashText(sourceEn),
    promptWords: words,
  });
  return {
    session: next,
    visibleText: [
      "回译训练｜新题",
      `训练重点：${focus}`,
      `参考长度：${words} 词`,
      "",
      `中文：${promptZh}`,
      "",
      "请直接写出英文。提交后才会显示原文和批改。",
    ].join("\n"),
  };
}

export async function recordBacktranslationAnswer(runtime, answer) {
  const session = await readActiveBacktranslationSession(runtime.projectRoot);
  if (!session || session.phase !== "answer") throw new Error("当前不在回译作答阶段");
  const userAnswer = requireText(answer, "回译答案");
  return saveSession(runtime, {
    ...session,
    phase: session.kind === "review" ? "assess" : "correct",
    userAnswer,
  });
}

export async function recordBacktranslationCorrection(runtime, candidateText) {
  const session = await readActiveBacktranslationSession(runtime.projectRoot);
  if (!session || session.phase !== "correct") throw new Error("当前不在回译批改阶段");
  const { data, visibleText } = extractMarker(candidateText, "RTO_BT_CORRECTION");
  const passed = requireBoolean(data.passed, "第一次通过状态");
  const mustModifyCount = requireNonNegativeInteger(data.mustModifyCount, "必须修改数量");
  const errorPatterns = Array.isArray(data.errorPatterns)
    ? data.errorPatterns.map((item) => requireText(item, "错误模式"))
    : [];
  const rewritePromptZh = optionalText(data.rewritePromptZh) ?? session.promptZh;
  const rewriteReferenceEn = optionalText(data.rewriteReferenceEn) ?? session.sourceEn;
  const correctionFocus = optionalText(data.rewriteFocus)
    ?? errorPatterns[0]
    ?? (passed ? `巩固原题训练重点：${session.focus}` : session.focus);
  const correctionText = requireText(visibleText, "可见批改内容");
  const prepared = {
    ...session,
    phase: "rewrite",
    firstAttemptPassed: passed,
    mustModifyCount,
    rewritePromptZh,
    rewriteReferenceEn,
    correctionFocus,
    errorPatterns,
    correctionText,
  };
  if (passed) {
    const result = await completeNewBacktranslation(runtime, {
      ...prepared,
      phase: "assess",
      userRewrite: session.userAnswer,
      rewriteSkipped: true,
    }, "首次作答已经通过，无需重复重写。", true);
    return {
      ...result,
      visibleText: [
        correctionText,
        "",
        `原题训练重点：${session.focus}`,
        `本次纠错重点：${correctionFocus}`,
        "",
        "## 原文参考",
        session.sourceEn,
        "",
        "首次作答已经通过，本次不再要求重复重写。",
        "",
        result.storageText,
        "本题已进入复习队列；下一个输出位将进行第 2 次复习。",
      ].join("\n"),
    };
  }
  const next = await saveSession(runtime, prepared);
  return {
    session: next,
    visibleText: [
      correctionText,
      "",
      `原题训练重点：${session.focus}`,
      `本次纠错重点：${correctionFocus}`,
      "",
      "## 原文参考",
      session.sourceEn,
      "",
      "## 本次重写",
      rewritePromptZh,
    ].join("\n"),
  };
}

export async function recordBacktranslationRewrite(runtime, rewrite) {
  const session = await readActiveBacktranslationSession(runtime.projectRoot);
  if (!session || session.phase !== "rewrite") throw new Error("当前不在回译重写阶段");
  const userRewrite = requireText(rewrite, "本次重写答案");
  return saveSession(runtime, { ...session, phase: "assess", userRewrite });
}

function renderRecord(session, assessmentText, finalPassed, date) {
  return [
    `# Ch${session.chapterNumber}-${session.segmentId} 回译 — ${date}`,
    "",
    `**书籍：** ${session.bookName}`,
    `**章节：** Ch${session.chapterNumber} ${session.chapterTitle}`,
    `**原题训练重点：** ${session.focus}`,
    `**本次纠错重点：** ${session.correctionFocus}`,
    `**第一次通过：** ${session.firstAttemptPassed ? "是" : "否"}`,
    `**即时重写：** ${session.rewriteSkipped ? "首次通过，已跳过" : "已完成"}`,
    `**本次重写通过：** ${finalPassed ? "是" : "否"}`,
    "",
    "## 中文题目",
    session.promptZh,
    "",
    "## 第一次作答",
    session.userAnswer,
    "",
    "## 英文原文",
    session.sourceEn,
    "",
    session.correctionText,
    "",
    ...(session.rewriteSkipped
      ? []
      : [
          "## 本次重写题目",
          session.rewritePromptZh,
          "",
          "## 本次重写答案",
          session.userRewrite,
          "",
        ]),
    `## ${session.rewriteSkipped ? "首次通过说明" : "重写核对"}`,
    assessmentText,
    "",
  ].join("\n");
}

function assertWithinVault(runtime, target, label) {
  const root = path.resolve(runtime.config.vaultRoot);
  const resolved = path.resolve(target);
  const relation = path.relative(root, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} 不在 Obsidian 库允许目录内：${resolved}`);
  }
  return resolved;
}

async function readOptionalFile(target) {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function recordSpellingIssues(runtime, session) {
  const userAnswer = session.userAnswer ?? session.userRewrite ?? "";
  const referenceEn = session.kind === "review"
    ? session.rewriteReferenceEn ?? ""
    : session.sourceEn ?? "";
  if (!userAnswer.trim() || !referenceEn.trim()) return null;
  const candidates = detectSpellingIssues(userAnswer, referenceEn);
  const feedback = [
    ...(session.errorPatterns ?? []),
    session.correctionText ?? "",
    session.assessmentText ?? "",
  ].join("\n");
  const issues = confirmSpellingIssues(candidates, feedback);
  if (!issues.length) return null;
  const history = await readSpellingHistory(runtime);
  const { history: nextHistory, records } = advanceSpellingHistory(history, issues);
  await atomicWrite(spellingHistoryPath(runtime), `${JSON.stringify(nextHistory, null, 2)}\n`);
  if (records.length) {
    return updateSpellingBook(runtime, records);
  }
  return null;
}

async function runBacktranslationTransaction(runtime, session, notePath, operation) {
  assertBacktranslationRuntime(runtime);
  const safeNotePath = assertWithinVault(runtime, notePath, "回译笔记");
  if (runtime.config.sandbox === true) {
    return { value: await operation(safeNotePath), backupRoot: null };
  }

  const targets = {
    "active-output-session.json": path.join(runtime.runtimeRoot, OUTPUT_SESSION_FILE),
    "backtranslation-queue.json": backtranslationQueuePath(runtime),
    "backtranslation-note.md": safeNotePath,
    "state.json": path.join(runtime.runtimeRoot, "state.json"),
    "spelling-history.json": spellingHistoryPath(runtime),
    "spelling-book.md": path.join(runtime.config.vaultRoot, "回译错题单词本.md"),
  };
  if (runtime.config.progressFile) {
    targets["progress.md"] = path.join(runtime.config.vaultRoot, runtime.config.progressFile);
  }
  const originals = {};
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupRoot = path.join(
    runtime.runtimeRoot,
    "backups",
    `backtranslation-${stamp}-${session.id.slice(0, 8)}`,
  );
  await mkdir(backupRoot, { recursive: true });
  const manifest = [];
  for (const [label, target] of Object.entries(targets)) {
    const content = await readOptionalFile(target);
    originals[label] = content;
    if (content !== null) {
      await writeFile(path.join(backupRoot, label), content, "utf8");
    }
    manifest.push({ label, source: target, existed: content !== null });
  }
  await writeFile(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  try {
    return { value: await operation(safeNotePath), backupRoot };
  } catch (error) {
    for (const [label, target] of Object.entries(targets)) {
      const content = originals[label];
      if (content === null) await unlink(target).catch(() => {});
      else await atomicWrite(target, content);
    }
    throw new Error(`真实回译存档失败，已回滚：${error.message}`);
  }
}

function storageText(runtime, backupRoot, action) {
  return runtime.config.sandbox === true
    ? `🧪 ${action}｜真实 Obsidian 未修改`
    : `✅ ${action}｜已写入 Obsidian${backupRoot ? "，并创建写入前备份" : ""}`;
}

async function completeNewBacktranslation(runtime, session, assessmentText, passed) {
  const date = new Date().toISOString().slice(0, 10);
  const notePath = path.join(
    runtime.config.vaultRoot,
    "回译",
    `Ch${session.chapterNumber}-${session.segmentId}-${date}-${session.id.slice(0, 8)}.md`,
  );
  const transaction = await runBacktranslationTransaction(
    runtime,
    session,
    notePath,
    async (safeNotePath) => {
      await atomicWrite(safeNotePath, renderRecord(session, assessmentText, passed, date));
      const completed = await saveSession(runtime, {
        ...session,
        phase: "completed",
        finalPassed: passed,
        assessmentText,
        notePath: safeNotePath,
        completedAt: new Date().toISOString(),
      });
      await registerFirstAttempt(runtime, completed);
      const cadence = await updateCadenceAfterBacktranslation(runtime, completed);
      const spellingBookPath = await recordSpellingIssues(runtime, completed);
      return { completed, notePath: safeNotePath, cadence, spellingBookPath };
    },
  );
  return {
    session: transaction.value.completed,
    notePath: transaction.value.notePath,
    backupRoot: transaction.backupRoot,
    storageText: storageText(runtime, transaction.backupRoot, "回译存档完成"),
    cadence: transaction.value.cadence,
  };
}

function renderReviewRecord(session, assessmentText, passed) {
  return [
    "",
    `<!--RTO_BT_REVIEW:${session.id}-->`,
    "---",
    "",
    `## 第 ${session.attemptNumber} 次复习`,
    "",
    `**复习时间：** ${new Date().toISOString()}`,
    `**本次纠错重点：** ${session.correctionFocus || session.focus}`,
    `**是否通过：** ${passed ? "是" : "否"}`,
    "",
    "### 锁定中文题目",
    session.promptZh,
    "",
    "### 本次作答",
    session.userAnswer,
    "",
    "### 锁定参考英文",
    session.rewriteReferenceEn,
    "",
    "### 核对",
    assessmentText,
    "",
  ].join("\n");
}

async function appendReviewRecord(notePath, content) {
  if (!notePath) throw new Error("复习项目缺少原回译笔记路径");
  let existing;
  try {
    existing = await readFile(notePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existing = "# 回译复习记录\n";
  }
  const marker = content.match(/<!--RTO_BT_REVIEW:[^>]+-->/u)?.[0];
  if (marker && existing.includes(marker)) return;
  await atomicWrite(notePath, `${existing.trimEnd()}\n${content}`);
}

export async function finalizeBacktranslation(runtime, candidateText) {
  assertBacktranslationRuntime(runtime);
  const session = await readActiveBacktranslationSession(runtime.projectRoot);
  if (!session || session.phase !== "assess") throw new Error("当前不在回译重写核对阶段");
  const { data, visibleText } = extractMarker(candidateText, "RTO_BT_ASSESSMENT");
  const passed = requireBoolean(data.passed, "重写通过状态");
  requireNonNegativeInteger(data.mustModifyCount, "重写必须修改数量");
  const assessmentText = requireText(visibleText, "重写核对内容");
  if (session.kind === "review") {
    const transaction = await runBacktranslationTransaction(
      runtime,
      session,
      session.notePath,
      async (safeNotePath) => {
        await appendReviewRecord(safeNotePath, renderReviewRecord(session, assessmentText, passed));
        const queueResult = await completeReviewAttempt(runtime, session, passed);
        const completed = await saveSession(runtime, {
          ...session,
          notePath: safeNotePath,
          phase: "completed",
          finalPassed: passed,
          assessmentText,
          completedAt: new Date().toISOString(),
          reviewStatus: queueResult.item.status,
          nextAttempt: queueResult.item.nextAttempt,
          nextEligibleSlot: queueResult.item.nextEligibleSlot,
        });
        const cadence = await updateCadenceAfterBacktranslation(runtime, completed);
        const spellingBookPath = await recordSpellingIssues(runtime, completed);
        return { queueResult, completed, notePath: safeNotePath, cadence, spellingBookPath };
      },
    );
    const { queueResult, completed } = transaction.value;
    const nextMessage = queueResult.item.status === "waiting"
      ? "本题仍需第 3 次复习；系统会先跳过一个输出位，再自动安排。"
      : "本题复习已经结束。";
    return {
      session: completed,
      notePath: transaction.value.notePath,
      backupRoot: transaction.backupRoot,
      visibleText: [
        assessmentText,
        "",
        storageText(runtime, transaction.backupRoot, `第 ${session.attemptNumber} 次复习已存档`),
        nextMessage,
      ].join("\n"),
    };
  }
  const result = await completeNewBacktranslation(runtime, session, assessmentText, passed);
  return {
    session: result.session,
    notePath: result.notePath,
    backupRoot: result.backupRoot,
    visibleText: [
      assessmentText,
      "",
      result.storageText,
      "本题已进入复习队列；下一个输出位将进行第 2 次复习。",
    ].join("\n"),
  };
}

export function backtranslationPhaseGuidance(session) {
  if (session.kind === "review") {
    const reviewGuidance = {
      answer: `请完成第 ${session.attemptNumber} 次回译；提交后显示核对。`,
      assess: `正在核对第 ${session.attemptNumber} 次回译。`,
      completed: `第 ${session.attemptNumber} 次复习已经完成并存档。`,
    };
    if (reviewGuidance[session.phase]) return reviewGuidance[session.phase];
  }
  const guidance = {
    select: "正在从已核对原文中生成回译题。",
    answer: "请直接写出英文；提交后显示原文和批改。",
    correct: "正在批改你的回译。",
    rewrite: "请只完成“本次重写”中的一句。",
    assess: "正在核对本次重写。",
    completed: session.sandbox
      ? "本次沙盒回译已经完成并存档。"
      : "本次回译已经完成并写入 Obsidian。",
  };
  return guidance[session.phase];
}

export function renderBacktranslationCard(session) {
  const phaseNames = {
    select: "选题中",
    answer: "等待作答",
    correct: "批改中",
    rewrite: "等待重写",
    assess: "核对重写中",
    completed: "已完成",
  };
  return [
    `Read-to-Output｜${session.sandbox ? "回译沙盒" : "回译"}`,
    `来源：${session.bookName}｜Ch${session.chapterNumber}-${session.segmentId}`,
    ...(session.kind === "review" ? [`复习：第 ${session.attemptNumber} 次`] : []),
    `阶段：${phaseNames[session.phase]}`,
    ...(session.focus ? [`原题训练重点：${session.focus}`] : []),
    ...(session.correctionFocus ? [`本次纠错重点：${session.correctionFocus}`] : []),
    ...(session.kind === "review" && session.phase === "answer"
      ? ["", `中文：${session.promptZh}`]
      : []),
    backtranslationPhaseGuidance(session),
  ];
}

export function renderBacktranslationQuestion(session) {
  if (session.kind !== "review" || session.phase !== "answer") {
    throw new Error("当前没有待展示的回译复习题");
  }
  return [
    `回译复习｜第 ${session.attemptNumber} 次`,
    `复习重点：${session.correctionFocus || session.focus}`,
    "",
    `中文：${session.promptZh}`,
    "",
    "请直接写出英文。提交后显示参考原句和核对。",
  ].join("\n");
}

// Backward-compatible names for existing sandbox tests and older local callers.
export const startSandboxBacktranslation = startBacktranslation;
export const startSandboxBacktranslationReview = startBacktranslationReview;
export const finalizeSandboxBacktranslation = finalizeBacktranslation;
