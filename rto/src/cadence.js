import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./sandbox.js";
import { rewritePlanPresentation } from "./plan-metadata.js";

const WORD_LEVELS = {
  "25–40": { lower: 25, upper: 40 },
  "40–55": { lower: 40, upper: 55 },
  "20–30": { lower: 20, upper: 30 },
};
const DEFAULT_LEVEL = "25–40";
const PROMOTION_STREAK = 2;
const OVERLOAD_MINUTES = 15;
const OVERLOAD_ISSUES = 3;

export const BACKTRANSLATION_MODES = ["off", "light", "heavy"];
const DEFAULT_MODE = "light";

export function normalizeBacktranslationMode(value) {
  return BACKTRANSLATION_MODES.includes(value) ? value : DEFAULT_MODE;
}

/**
 * 阅读场完成后的节奏推进（正式与沙盒共用）：
 * - off：计数照常累加，但永远不安排回译场次；
 * - heavy：每次阅读后必做回译，计数归零，不依赖混合场轮换；
 * - light（默认）：两次普通阅读 → 混合场 → 回译归零。
 */
export function advanceCadence(state, sessionType) {
  const mode = state.cadence.backtranslationMode ?? "light";
  if (mode === "off") {
    const normalReadingCount = state.cadence.normalReadingCount + 1;
    return {
      ...state.cadence,
      normalReadingCount,
      nextSession: "ordinary",
    };
  }
  if (mode === "heavy") {
    return {
      ...state.cadence,
      normalReadingCount: 0,
      nextSession: "heavy_pending",
    };
  }
  if (sessionType === "mixed") {
    return { ...state.cadence, nextSession: "mixed_pending" };
  }
  const normalReadingCount = state.cadence.normalReadingCount + 1;
  return {
    ...state.cadence,
    normalReadingCount,
    nextSession: normalReadingCount >= 2 ? "mixed" : "ordinary",
  };
}

function statePath(runtime) {
  return path.join(runtime.runtimeRoot, "state.json");
}

export function normalizeWordLevel(value) {
  return Object.hasOwn(WORD_LEVELS, value) ? value : DEFAULT_LEVEL;
}

export function backtranslationWordRange(value) {
  const level = normalizeWordLevel(value);
  return { level, ...WORD_LEVELS[level] };
}

export function nextWordLevel(level, direction) {
  const order = ["20–30", "25–40", "40–55"];
  const index = order.indexOf(normalizeWordLevel(level));
  if (direction === "up") return order[Math.min(order.length - 1, index + 1)];
  return order[Math.max(0, index - 1)];
}

/**
 * 按原 skill 的自适应数量规则计算回译完成后的 cadence：
 * - 新题无“必须修改”且重写通过 → cleanStreak+1；连续 2 次 → 提到 40–55 词；
 * - 超过 15 分钟或出现 3 个以上彼此独立的“必须修改” → 降到 20–30 词；
 * - 其他情况保持当前档位，cleanStreak 归零（信息不足时保持档位）。
 * 任何情况下回译完成后普通阅读场计数归零、下次场次改回普通阅读场。
 */
export function advanceCadenceAfterBacktranslation(cadence, session) {
  const wasNew = session.kind === "new";
  const passed = session.finalPassed === true;
  const mustModifyCount = session.mustModifyCount ?? 0;
  const minutes = session.completedAt && session.startedAt
    ? (Date.parse(session.completedAt) - Date.parse(session.startedAt)) / 60000
    : null;
  const overloaded = minutes !== null && minutes > OVERLOAD_MINUTES;
  const issueOverload = mustModifyCount >= OVERLOAD_ISSUES;

  let cleanStreak = cadence.cleanStreak ?? 0;
  let level = normalizeWordLevel(cadence.newBacktranslationWords);

  if (wasNew) {
    if (passed && mustModifyCount === 0 && !overloaded) {
      cleanStreak += 1;
      if (cleanStreak >= PROMOTION_STREAK) {
        level = nextWordLevel(level, "up");
        cleanStreak = 0;
      }
    } else {
      cleanStreak = 0;
      if (overloaded || issueOverload) {
        level = nextWordLevel(level, "down");
      }
    }
  } else if (overloaded || issueOverload) {
    level = nextWordLevel(level, "down");
  }

  // 混合场、light 轮换（mixed）或重度模式完成回译后归零：计数清零、下次场次改回普通阅读场。
  // 普通场用户主动回译不改变阅读节奏，只更新参考量档位。
  if (cadence.nextSession === "mixed" || cadence.nextSession === "mixed_pending" || cadence.nextSession === "heavy_pending") {
    return {
      normalReadingCount: 0,
      nextSession: "ordinary",
      newBacktranslationWords: level,
      cleanStreak,
      backtranslationMode: cadence.backtranslationMode,
    };
  }
  return {
    ...cadence,
    newBacktranslationWords: level,
    cleanStreak,
  };
}

/**
 * 切换回译模式：off（纯阅读）/ light（两次阅读一次回忆）/ heavy（每次必做）。
 * 切换时重置节奏计数与待输出状态，避免残留状态影响新模式。
 */
export function switchBacktranslationMode(cadence, mode) {
  const normalized = normalizeBacktranslationMode(mode);
  return {
    ...cadence,
    backtranslationMode: normalized,
    normalReadingCount: 0,
    nextSession: "ordinary",
  };
}

export async function persistBacktranslationMode(runtime, mode) {
  if (runtime.config.sandbox !== true && runtime.config.writeMode !== "real") {
    throw new Error("回译模式更新需要 config.writeMode 显式设为 real");
  }
  const target = statePath(runtime);
  const state = JSON.parse(await readFile(target, "utf8"));
  const nextCadence = switchBacktranslationMode(state.cadence ?? {}, mode);
  let sourceSnapshot = state.sourceSnapshot;
  if (runtime.config.sandbox !== true && runtime.config.progressFile) {
    try {
      const progressStat = await updateProgressCadence(runtime, nextCadence);
      sourceSnapshot = {
        size: progressStat.size,
        lastWriteTimeUtc: progressStat.mtime.toISOString(),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const nextBooks = Object.fromEntries(Object.entries(state.books ?? {}).map(([bookId, book]) => [
    bookId,
    nextCadence.backtranslationMode === "off" && book.nextSegment
      ? { ...book, nextSegment: { ...book.nextSegment, sessionType: "ordinary" } }
      : book,
  ]));
  await atomicWrite(target, `${JSON.stringify({
    ...state,
    generatedAt: new Date().toISOString(),
    sourceSnapshot,
    cadence: nextCadence,
    books: nextBooks,
  }, null, 2)}\n`);
  return nextCadence;
}

export function backtranslationModeLabel(mode) {
  const labels = {
    off: "纯阅读（不安排回译）",
    light: "轻量（两次阅读，一次回忆）",
    heavy: "重度（每次阅读后必做回译）",
  };
  return labels[normalizeBacktranslationMode(mode)];
}

export async function updateCadenceAfterBacktranslation(runtime, session) {
  if (runtime.config.sandbox !== true && runtime.config.writeMode !== "real") {
    throw new Error("回译节奏更新需要 config.writeMode 显式设为 real");
  }
  const target = statePath(runtime);
  let state;
  try {
    state = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const nextCadence = advanceCadenceAfterBacktranslation(state.cadence, session);
  let sourceSnapshot = state.sourceSnapshot;
  if (runtime.config.sandbox !== true && runtime.config.progressFile) {
    try {
      const progressStat = await updateProgressCadence(runtime, nextCadence);
      sourceSnapshot = {
        size: progressStat.size,
        lastWriteTimeUtc: progressStat.mtime.toISOString(),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const nextState = {
    ...state,
    generatedAt: new Date().toISOString(),
    sourceSnapshot,
    cadence: nextCadence,
  };
  await atomicWrite(target, `${JSON.stringify(nextState, null, 2)}\n`);
  return nextCadence;
}

function replaceUniqueField(progress, field, value) {
  const pattern = new RegExp(`^- ${field}：.*$`, "mu");
  const matches = [...progress.matchAll(new RegExp(pattern.source, "gmu"))];
  if (matches.length !== 1) {
    throw new Error(`全局字段 ${field} 应唯一存在，当前 ${matches.length} 个`);
  }
  return progress.replace(pattern, `- ${field}：${value}`);
}

async function updateProgressCadence(runtime, cadence) {
  const progressPath = path.join(runtime.config.vaultRoot, runtime.config.progressFile);
  const progress = rewritePlanPresentation(
    await readFile(progressPath, "utf8"),
    { forceOrdinary: cadence.backtranslationMode === "off" },
  );
  const nextSessionLabel = cadence.nextSession === "mixed"
    || cadence.nextSession === "mixed_pending"
    || cadence.nextSession === "heavy_pending"
    ? "回译待输出"
    : "普通阅读场";
  let updated = replaceUniqueField(progress, "普通阅读场计数", cadence.normalReadingCount);
  updated = replaceUniqueField(updated, "下次场次", nextSessionLabel);
  if (cadence.backtranslationMode !== undefined) {
    try {
      updated = replaceUniqueField(updated, "回译模式", backtranslationModeLabel(cadence.backtranslationMode));
    } catch {
      // 进度文件没有“回译模式”字段时不强制添加（旧文件兼容）
    }
  }
  await atomicWrite(progressPath, updated);
  const { stat } = await import("node:fs/promises");
  return stat(progressPath);
}
