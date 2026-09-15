import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./sandbox.js";

const QUEUE_FILE = "backtranslation-queue.json";

export function assertBacktranslationRuntime(runtime) {
  if (runtime.config.sandbox === true) {
    const expectedRoot = path.resolve(runtime.projectRoot, "sandbox-vault");
    if (path.resolve(runtime.config.vaultRoot) !== expectedRoot) {
      throw new Error("拒绝写入：回译沙盒库路径不在项目 sandbox-vault");
    }
    return;
  }
  if (runtime.config.writeMode !== "real") {
    throw new Error("真实回译写入未启用：config.writeMode 必须明确设为 real");
  }
  if (runtime.freshness?.status !== "current") {
    throw new Error(`拒绝写入：${runtime.freshness?.reason ?? "真实学习状态不是最新快照"}`);
  }
}

export function backtranslationQueuePath(runtime) {
  return path.join(runtime.runtimeRoot, QUEUE_FILE);
}

function emptyQueue() {
  return {
    version: 1,
    currentSlot: 0,
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

function validateQueue(queue) {
  if (!queue || typeof queue !== "object" || queue.version !== 1) {
    throw new Error("backtranslation-queue.json 格式无效");
  }
  if (!Number.isInteger(queue.currentSlot) || queue.currentSlot < 0) {
    throw new Error("回译队列 currentSlot 无效");
  }
  if (!Array.isArray(queue.items)) throw new Error("回译队列 items 必须是数组");
  return queue;
}

async function saveQueue(runtime, queue) {
  const next = { ...queue, updatedAt: new Date().toISOString() };
  await atomicWrite(backtranslationQueuePath(runtime), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function readBacktranslationQueue(runtime) {
  assertBacktranslationRuntime(runtime);
  try {
    return validateQueue(JSON.parse(await readFile(backtranslationQueuePath(runtime), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyQueue();
    throw error;
  }
}

function dueItemForSlot(queue, currentSlot) {
  return queue.items
    .filter((item) => item.status === "waiting" && item.nextEligibleSlot <= currentSlot)
    .sort((left, right) => (
      left.nextEligibleSlot - right.nextEligibleSlot
      || left.createdAt.localeCompare(right.createdAt)
    ))[0] ?? null;
}

export async function previewBacktranslationSlot(runtime) {
  const queue = await readBacktranslationQueue(runtime);
  const currentSlot = queue.currentSlot + 1;
  return { queue, item: dueItemForSlot(queue, currentSlot), currentSlot };
}

export async function registerFirstAttempt(runtime, session) {
  assertBacktranslationRuntime(runtime);
  const queue = await readBacktranslationQueue(runtime);
  if (queue.items.some((item) => item.id === session.id)) return queue;
  const firstPassed = session.firstAttemptPassed === true;
  const correctionFocus = session.correctionFocus?.trim()
    || session.errorPatterns?.[0]?.trim()
    || session.focus;
  const item = {
    id: session.id,
    bookId: session.bookId,
    bookName: session.bookName,
    chapterNumber: session.chapterNumber,
    chapterTitle: session.chapterTitle,
    segmentId: session.segmentId,
    sourceEn: session.sourceEn,
    sourceEnHash: session.sourceEnHash,
    originalFocus: session.focus,
    correctionFocus,
    lockedPromptZh: session.rewritePromptZh,
    lockedReferenceEn: session.rewriteReferenceEn,
    errorPatterns: session.errorPatterns ?? [],
    notePath: session.notePath,
    attempts: [{
      number: 1,
      passed: firstPassed,
      completedAt: session.completedAt ?? new Date().toISOString(),
    }],
    nextAttempt: 2,
    nextEligibleSlot: queue.currentSlot + 1,
    status: "waiting",
    createdAt: session.completedAt ?? new Date().toISOString(),
  };
  return saveQueue(runtime, { ...queue, items: [...queue.items, item] });
}

export async function openBacktranslationSlot(runtime) {
  assertBacktranslationRuntime(runtime);
  const queue = await readBacktranslationQueue(runtime);
  const currentSlot = queue.currentSlot + 1;
  const due = dueItemForSlot(queue, currentSlot);
  const next = await saveQueue(runtime, { ...queue, currentSlot });
  return { queue: next, item: due, currentSlot };
}

export async function completeReviewAttempt(runtime, session, passed) {
  assertBacktranslationRuntime(runtime);
  const queue = await readBacktranslationQueue(runtime);
  const index = queue.items.findIndex((item) => item.id === session.queueItemId);
  if (index < 0) throw new Error("复习项目不在回译队列中");
  const item = queue.items[index];
  if (item.attempts.some((attempt) => attempt.number === session.attemptNumber)) {
    return { queue, item };
  }
  if (item.nextAttempt !== session.attemptNumber) {
    throw new Error("复习次数与队列状态不一致");
  }
  const attempts = [...item.attempts, {
    number: session.attemptNumber,
    passed,
    answer: session.userAnswer,
    completedAt: new Date().toISOString(),
  }];
  let updated;
  if (session.attemptNumber === 2) {
    const firstPassed = attempts.find((attempt) => attempt.number === 1)?.passed === true;
    updated = firstPassed && passed
      ? { ...item, attempts, status: "graduated", nextAttempt: null, nextEligibleSlot: null }
      : {
          ...item,
          attempts,
          status: "waiting",
          nextAttempt: 3,
          nextEligibleSlot: queue.currentSlot + 2,
        };
  } else {
    updated = { ...item, attempts, status: "finished", nextAttempt: null, nextEligibleSlot: null };
  }
  const items = [...queue.items];
  items[index] = updated;
  return {
    queue: await saveQueue(runtime, { ...queue, items }),
    item: updated,
  };
}

export function usedBacktranslationSources(queue) {
  return queue.items
    .map((item) => item.sourceEn)
    .filter((source) => typeof source === "string" && source.trim());
}
