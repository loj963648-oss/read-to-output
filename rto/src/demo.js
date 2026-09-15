import { createHash, randomUUID } from "node:crypto";
import { writeActiveSession } from "./session.js";

export const DEMO_SOURCE_TEXT = [
  "A model is a simplified representation of reality. Economists build models to explain how people, firms, and governments make choices when resources are limited.",
  "Scarcity means that wants exceed what is available, so every choice involves a tradeoff. When you choose one option, you give up the next best alternative, which is called the opportunity cost.",
  "Markets coordinate decisions through prices. When a good becomes scarce, its price rises, giving buyers a reason to use less and sellers a reason to produce more.",
].join(" ");

export const DEMO_EXPLANATION = [
  "这一段讲的是经济模型和稀缺性。",
  "第一，模型是对现实的简化，经济学家用它来解释人们在资源有限时怎么做选择。",
  "第二，稀缺意味着想要的东西超过可用的东西，所以每次选择都有取舍，放弃的下一个最好选择叫机会成本。",
  "第三，市场靠价格来协调：东西变稀缺时价格上升，买家少用、卖家多产。",
].join("");

export const DEMO_ANSWERS = [
  "因为模型只保留最重要的关系，把无关细节去掉，才能看清因果。",
  "稀缺是原因：资源有限，选了一个就得放弃另一个，所以每个选择都有机会成本。",
  "价格上升同时改变了买卖双方的动力：买家少买，卖家多生产，市场重新平衡。",
];

export function demoSourceHash() {
  return createHash("sha256").update(DEMO_SOURCE_TEXT, "utf8").digest("hex");
}

function countWords(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function isDemoSession(session) {
  return session?.demo === true;
}

/**
 * 创建正式模式的演示学习场：使用内置示例内容，不触碰真实图书。
 * 演示场结束后不会写入任何 Obsidian 文件。
 */
export async function startDemoReading(runtime) {
  const now = new Date().toISOString();
  const session = {
    version: 1,
    id: randomUUID(),
    demo: true,
    sandbox: false,
    phase: "reading",
    bookId: "demo",
    bookName: "演示内容（不会写入任何笔记）",
    chapterNumber: 1,
    chapterTitle: "Demo Chapter",
    segmentId: "DEMO",
    sessionType: "ordinary",
    planningMode: "segment",
    totalMinutes: null,
    estimatedReadingMinutes: null,
    startAnchor: DEMO_SOURCE_TEXT.slice(0, 60),
    plannedEndAnchor: DEMO_SOURCE_TEXT.slice(-60),
    actualEndAnchor: DEMO_SOURCE_TEXT.slice(-60),
    sourceText: DEMO_SOURCE_TEXT,
    sourceHash: demoSourceHash(),
    sourceWords: countWords(DEMO_SOURCE_TEXT),
    sourceCharacters: DEMO_SOURCE_TEXT.length,
    fullSourceWords: countWords(DEMO_SOURCE_TEXT),
    remainingWords: 0,
    remainingStartAnchor: null,
    studentTurnsUsed: 0,
    scopeExplanation: "",
    feynmanUserTurns: [],
    feynmanDialogue: [],
    testExplanation: DEMO_EXPLANATION,
    testAnswers: DEMO_ANSWERS,
    accumulatedReadingMs: 0,
    lastResumeAt: now,
    startedAt: now,
    updatedAt: now,
  };
  return writeActiveSession(runtime.projectRoot, session);
}
