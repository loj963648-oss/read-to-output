import { stat } from "node:fs/promises";
import { finalizeRealSession, prepareRealReading } from "./real-storage.js";
import { finalizeSandboxSession, prepareSandboxReading } from "./sandbox.js";

export async function prepareLearningReading(runtime, session) {
  if (session.demo === true) {
    return { demo: true, chapterPath: null };
  }
  const result = runtime.config.sandbox === true
    ? await prepareSandboxReading(runtime, session)
    : await prepareRealReading(runtime, session);
  if (!result.chapterPath) return result;
  const chapterStat = await stat(result.chapterPath);
  return {
    ...result,
    chapterSnapshot: {
      size: chapterStat.size,
      lastWriteTimeUtc: chapterStat.mtime.toISOString(),
    },
  };
}

export async function finalizeLearningSession(runtime, session, summaryText, noteTitle) {
  return runtime.config.sandbox === true
    ? finalizeSandboxSession(runtime, session, summaryText, noteTitle)
    : finalizeRealSession(runtime, session, summaryText, noteTitle);
}
