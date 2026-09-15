import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./sandbox.js";

const QUEUE_FILE = "knowledge-queue.json";
const INTERVAL_DAYS = [3, 7, 14, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

export function knowledgeQueuePath(runtime) {
  return path.join(runtime.runtimeRoot, QUEUE_FILE);
}

export function assertKnowledgeRuntime(runtime) {
  if (runtime.config.sandbox === true) return;
  if (runtime.config.writeMode !== "real") {
    throw new Error("知识复习队列需要 config.writeMode 显式设为 real");
  }
  if (runtime.freshness?.status !== "current") {
    throw new Error(`知识复习队列需要学习进度快照有效：${runtime.freshness?.reason ?? ""}`);
  }
}

function emptyQueue() {
  return { version: 1, items: [] };
}

function validateQueue(queue) {
  if (!queue || typeof queue !== "object" || queue.version !== 1) {
    throw new Error("knowledge-queue.json 格式无效");
  }
  if (!Array.isArray(queue.items)) throw new Error("knowledge-queue.json 缺少 items 数组");
  for (const item of queue.items) {
    if (!item || typeof item.id !== "string" || typeof item.content !== "string") {
      throw new Error("knowledge-queue.json 中存在无效条目");
    }
    if (!["active", "stopped", "graduated"].includes(item.status)) {
      throw new Error(`knowledge-queue.json 条目状态无效：${item.status}`);
    }
    if (!Number.isInteger(item.intervalIndex) || item.intervalIndex < 0) {
      throw new Error("knowledge-queue.json 条目间隔索引无效");
    }
    if (!Number.isFinite(Date.parse(item.nextReviewAt))) {
      throw new Error("knowledge-queue.json 条目复习时间无效");
    }
  }
  return queue;
}

async function saveQueue(runtime, queue) {
  await atomicWrite(knowledgeQueuePath(runtime), `${JSON.stringify(queue, null, 2)}\n`);
  return queue;
}

export async function readKnowledgeQueue(runtime) {
  assertKnowledgeRuntime(runtime);
  try {
    return validateQueue(JSON.parse(await readFile(knowledgeQueuePath(runtime), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return emptyQueue();
    throw error;
  }
}

export async function addKnowledgeItem(runtime, { content, source = null }) {
  assertKnowledgeRuntime(runtime);
  const text = content.trim();
  if (!text) throw new Error("想记住的内容不能为空");
  const queue = await readKnowledgeQueue(runtime);
  const now = new Date();
  const item = {
    id: randomUUID(),
    content: text,
    source,
    intervalIndex: 0,
    nextReviewAt: new Date(now.getTime() + INTERVAL_DAYS[0] * DAY_MS).toISOString(),
    status: "active",
    reviewCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const next = { ...queue, items: [...queue.items, item] };
  await saveQueue(runtime, next);
  return item;
}

export async function dueKnowledgeItem(runtime, now = new Date()) {
  assertKnowledgeRuntime(runtime);
  const queue = await readKnowledgeQueue(runtime);
  return queue.items
    .filter((item) => item.status === "active" && Date.parse(item.nextReviewAt) <= now.getTime())
    .sort((left, right) => (
      Date.parse(left.nextReviewAt) - Date.parse(right.nextReviewAt)
      || left.createdAt.localeCompare(right.createdAt)
    ))[0] ?? null;
}

export async function reviewKnowledgeItem(runtime, itemId, passed) {
  assertKnowledgeRuntime(runtime);
  const queue = await readKnowledgeQueue(runtime);
  const index = queue.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error("知识点不在复习队列中");
  const item = queue.items[index];
  if (item.status !== "active") return { queue, item };
  const now = new Date();
  let nextIndex = item.intervalIndex;
  let status = item.status;
  if (passed) {
    if (item.intervalIndex >= INTERVAL_DAYS.length - 1) {
      status = "graduated";
    } else {
      nextIndex = item.intervalIndex + 1;
    }
  } else {
    nextIndex = Math.max(0, item.intervalIndex - 1);
  }
  const updated = {
    ...item,
    intervalIndex: nextIndex,
    nextReviewAt: status === "graduated"
      ? item.nextReviewAt
      : new Date(now.getTime() + INTERVAL_DAYS[nextIndex] * DAY_MS).toISOString(),
    status,
    reviewCount: item.reviewCount + 1,
    updatedAt: now.toISOString(),
  };
  const items = [...queue.items];
  items[index] = updated;
  await saveQueue(runtime, { ...queue, items });
  return { queue: { ...queue, items }, item: updated };
}

export async function stopKnowledgeItem(runtime, itemId) {
  assertKnowledgeRuntime(runtime);
  const queue = await readKnowledgeQueue(runtime);
  const index = queue.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw new Error("知识点不在复习队列中");
  const item = queue.items[index];
  if (item.status !== "active") return { queue, item };
  const updated = { ...item, status: "stopped", updatedAt: new Date().toISOString() };
  const items = [...queue.items];
  items[index] = updated;
  await saveQueue(runtime, { ...queue, items });
  return { queue: { ...queue, items }, item: updated };
}

export function nextReviewLabel(item) {
  if (item.status === "graduated") return "已毕业（30 天通过，不再追踪）";
  if (item.status === "stopped") return "已停止追踪";
  return `${INTERVAL_DAYS[item.intervalIndex]} 天后`;
}
