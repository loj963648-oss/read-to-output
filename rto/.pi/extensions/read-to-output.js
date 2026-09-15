import { buildDashboard, findBook, loadRuntime, renderBookCard } from "../../src/state.js";
import path from "node:path";
import {
  backtranslationPhaseGuidance,
  buildBacktranslationSystemPrompt,
  cancelBacktranslation,
  finalizeBacktranslation,
  isBacktranslationModelPhase,
  isBacktranslationRequest,
  readActiveBacktranslationSession,
  recordBacktranslationAnswer,
  recordBacktranslationCorrection,
  recordBacktranslationRewrite,
  recordBacktranslationSelection,
  renderBacktranslationCard,
  renderBacktranslationQuestion,
  startBacktranslation,
  startBacktranslationReview,
} from "../../src/backtranslation-session.js";
import {
  openBacktranslationSlot,
  previewBacktranslationSlot,
  readBacktranslationQueue,
  registerFirstAttempt,
  usedBacktranslationSources,
} from "../../src/backtranslation-queue.js";
import { auditFeynmanOutput, REJECTED_QUESTION_MESSAGE } from "../../src/question-audit.js";
import { addKnowledgeItem, dueKnowledgeItem, nextReviewLabel, readKnowledgeQueue, reviewKnowledgeItem, stopKnowledgeItem } from "../../src/knowledge-queue.js";
import { judgeKnowledgeRecall } from "../../src/knowledge-review.js";
import {
  BACKTRANSLATION_MODES,
  backtranslationModeLabel,
  normalizeBacktranslationMode,
  persistBacktranslationMode,
} from "../../src/cadence.js";
import { rm } from "node:fs/promises";
import { planChapterSegments } from "../../src/segment-planner.js";
import { completeRealSegmentWithoutFeynman } from "../../src/real-storage.js";
import { importBook } from "../../src/book-importer.js";
import { bootstrapRuntime, isFirstRun } from "../../src/bootstrap.js";
import { API_PROVIDERS, isModelAvailable, storeApiKey } from "../../src/api-setup.js";
import { translateUserError } from "../../src/user-messages.js";
import { collectChapterNotes, synthesizeChapter } from "../../src/chapter-synthesis.js";
import { startDemoReading } from "../../src/demo.js";
import { finalizeLearningSession, prepareLearningReading } from "../../src/persistence.js";
import { extractNoteTitle, normalizeVerificationSummary } from "../../src/summary-normalize.js";
import {
  buildPhaseSystemPrompt,
  isFeynmanCompletionRequest,
  isScopeInOverride,
  isVerificationRequest,
  markSessionArchived,
  parseScopeDecision,
  readActiveSession,
  readLastVerifiedSession,
  recordFeynmanUserTurn,
  recordPreparedChapterSnapshot,
  recordScopeExplanation,
  recordStudentTurn,
  regressSession,
  renderSessionCard,
  recoverLastVerifiedSessionFromBackups,
  resumeReadingTimer,
  startReadingSession,
  stripScopeDecisionMarker,
  transitionSession,
  trimSessionAtEnd,
} from "../../src/session.js";

const WIDGET_ID = "read-to-output";
const BUILD_VERSION = "0.10.5";

function parseKnowledgeRememberRequest(text) {
  const trimmed = text.trim().replace(/^[、，,。；;：:！!？?\s]+/u, "");
  const withContent = trimmed.match(/^(?:我)?(?:想|要)(?:长期)?记住[：:]\s*(.+)$/u);
  if (withContent) return { content: withContent[1].trim() };
  const bare = /^(?:这个|这一点|这条|这里|这部分|这个知识点)?(?:我)?(?:想|要)(?:长期)?记住(?:这个|这一点|这条|这里|这部分|这个知识点)?[。！!]?$/u;
  if (bare.test(trimmed)) return { content: null };
  return null;
}

function isReviewAcceptRequest(text) {
  return /^(?:好|好的|可以|来吧|试试|开始|开始吧|回忆吧|嗯)[。！!]?$/u.test(text.trim());
}

function isReviewDeclineRequest(text) {
  return /^(?:不用|不用了|算了|跳过|下次吧|不了|不要)[。！!]?$/u.test(text.trim());
}

function isStopTrackingRequest(text) {
  return /^(?:停止追踪|不记这个|不用记了|别记了|删掉这个)[。！!]?$/u.test(text.trim());
}

function modeLine(runtime) {
  const mode = normalizeBacktranslationMode(runtime.state.cadence?.backtranslationMode);
  return `回译模式：${backtranslationModeLabel(mode)}（/learn mode 可切换）`;
}

function knowledgeSourceFrom(active) {
  if (!active) return null;
  return {
    bookId: active.bookId,
    bookName: active.bookName,
    chapterNumber: active.chapterNumber,
    chapterTitle: active.chapterTitle,
    segmentId: active.segmentId,
  };
}

function selectorLabel(book) {
  return `${book.name} — ${book.summary}${book.isLastBook ? "（最近）" : ""}`;
}

function isNaturalStartRequest(text) {
  return /^(今天学什么|今天读什么|开始学习|继续|继续学习|继续阅读|开始读书|继续读书|换一本|换书|换一本书|换本书|换另一本书|换本别的书|我想换书|我想换本书|我想换一本|读别的书)[？?。！! ]*$/u.test(text.trim());
}

function isContinueRequest(text) {
  return /^(继续|继续学习|继续阅读|继续读书)[？?。！! ]*$/u.test(text.trim());
}

function isSwitchBookRequest(text) {
  return /^(换一本|换书|换一本书|换本书|换另一本书|换本别的书|我想换书|我想换本书|我想换一本|读别的书)[？?。！! ]*$/u.test(text.trim());
}

function isReadingFinishedRequest(text) {
  return /^(读完了|我读完了|这段读完了|看完了|我看完了|读好了|读完了[，, ]*(?:我)?开始费曼|开始费曼|开始讲吧|我开始讲)[。！! ]*$/u.test(text.trim());
}

function looksLikeEnglishAnswer(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  // 必须有英文字母，且不能是纯中文/指令
  const letters = (t.match(/[a-zA-Z]/gu) ?? []).length;
  return letters >= 3;
}

function isDemoRequest(text) {
  return /^(演示|演示一下|自动演示|demo)[。！! ]*$/iu.test(text.trim());
}

function phaseGuidance(session) {
  const guidance = {
    reading: "继续阅读这一段；读完后直接在下方讲这段学到了什么，不必按 F2。",
    scope: session.scopeExplanation?.trim()
      ? "上次讲述已经保留；直接说“开始费曼”即可恢复。"
      : session.sandbox
        ? "直接用自己的话讲；若只测试流程，输入“演示一下”。"
        : [
            "用自己的话讲讲这段学到了什么（不用背原文，讲清楚就行）。",
            "可以参考这样的开场：这一段主要讲了……，其中最关键的是……，因为……",
            "讲完说“总结吧”进入核对。",
          ].join(" "),
    feynman: session.sandbox
      ? "回答学生追问；若只测试流程，输入“演示一下”自动回答。"
      : "继续回答学生追问；讲清楚后直接说“总结吧”。",
    verify: "正在进行原文核对。",
    verified: session.archivedAt || session.sandbox
      ? "本轮核对已经完成并存档。"
      : "核对已完成但尚未存档；请说“重新核对”生成并保存结果。",
  };
  return guidance[session.phase];
}

function replaceAssistantText(message, text) {
  return {
    ...message,
    content: [
      ...message.content.filter((block) => block.type !== "text"),
      { type: "text", text },
    ],
  };
}

async function auditVisibleQuestion(ctx, session, candidateText) {
  const audit = await auditFeynmanOutput(ctx, session, candidateText);
  if (audit.decision === "pass") return { passed: true, text: candidateText };
  if (audit.reason) {
    ctx.ui.notify(`费曼提问已被独立审核拦截：${audit.reason}`, "warning");
  }
  return { passed: false, text: REJECTED_QUESTION_MESSAGE };
}

function assistantText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function retryBacktranslationSelection(runtime, ctx, session, initialError) {
  if (!ctx.model || typeof ctx.modelRegistry?.complete !== "function") throw initialError;
  const queue = await readBacktranslationQueue(runtime);
  const retrySession = {
    ...session,
    excludedSourceTexts: usedBacktranslationSources(queue),
  };
  let lastError = initialError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: await buildBacktranslationSystemPrompt("", retrySession),
        messages: [{
          role: "user",
          content: `生成回译题。上一次输出未通过程序校验：${lastError.message}。这次只能输出规定的 RTO_BT_SELECTION 标记。`,
          timestamp: Date.now(),
        }],
        tools: [],
      },
      {
        maxTokens: 768,
        temperature: 0,
        signal: ctx.signal,
      },
    );
    try {
      return await recordBacktranslationSelection(runtime, assistantText(response));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function nextStudyChoice(ctx, session, { opening = false } = {}) {
  if (session.sandbox) return null;
  const active = await readActiveSession(ctx.cwd);
  if (active?.phase === "reading") {
    return [
      opening ? "今天想学什么？" : "接下来想做什么？",
      `- 继续阅读《${active.bookName}》${active.segmentId}`,
      "- 换一本书",
      "回复“继续阅读”或“换一本”。",
    ].join("\n");
  }
  return "接下来想学什么？我可以继续当前学习场，也可以让你换一本书。";
}

async function choosePlanningMode(ctx, { hasPlan = false } = {}) {
  const mode = await ctx.ui.select("今天怎么读？", hasPlan
    ? ["按分段计划继续（推荐）", "按时间读（读多少算多少）"]
    : ["按章节分段（推荐）", "按时间读（读多少算多少）"]);
  if (!mode) return null;
  if (mode.startsWith("按分段计划") || mode.startsWith("按章节分段")) return { mode: "segment" };

  while (true) {
    const rawMinutes = await ctx.ui.input("今天总共学习多少分钟？", "例如：45");
    if (rawMinutes === undefined) return null;
    const totalMinutes = Number(rawMinutes.trim());
    if (Number.isInteger(totalMinutes) && totalMinutes >= 10 && totalMinutes <= 240) {
      return { mode: "time", totalMinutes };
    }
    ctx.ui.notify("请输入 10–240 之间的整数分钟数；按 Esc 可返回。", "warning");
  }
}

async function chooseAndStartReading(runtime, dashboard, ctx, query = "", { promptForMode = false, forceAskMode = false } = {}) {
  let selectedBook = query ? findBook(dashboard, query) : null;
  if (query && !selectedBook) throw new Error(`无法唯一匹配图书：${query}`);
  if (!selectedBook && dashboard.books.length > 1) {
    const labels = dashboard.books.map(selectorLabel);
    const selectedLabel = await ctx.ui.select("今天读哪本？", labels);
    if (!selectedLabel) return null;
    selectedBook = dashboard.books[labels.indexOf(selectedLabel)];
  }
  selectedBook ??= dashboard.books[0];
  const hasPlan = Boolean(selectedBook.nextSegment);
  // 未规划章节必须先由用户决定；已有计划时，仅在明确“换书”时再次询问。
  const shouldAskMode = !hasPlan || (promptForMode && forceAskMode);
  const planning = shouldAskMode
    ? await choosePlanningMode(ctx, { hasPlan })
    : { mode: "segment" };
  if (!planning) return null;
  if (!selectedBook.nextSegment) {
    const planned = await planChapterSegments(runtime, selectedBook.id);
    runtime = await loadRuntime(ctx.cwd);
    dashboard = buildDashboard(runtime);
    selectedBook = dashboard.books.find((book) => book.id === selectedBook.id) ?? selectedBook;
    if (planning.mode === "segment") {
      ctx.ui.notify(
        `已生成本章分段计划（${planned.segments.length} 段，${planned.segments.map((segment) => `${segment.id} ${segment.plannedWords}词`).join(" / ")}）。`, "info",
      );
    } else {
      ctx.ui.notify(`按 ${planning.totalMinutes} 分钟开始本场阅读。`, "info");
    }
  }
  let active = await startReadingSession(runtime, selectedBook.id, planning);
  const prepared = await prepareLearningReading(runtime, active);
  if (prepared.chapterSnapshot) {
    active = await recordPreparedChapterSnapshot(runtime, prepared.chapterSnapshot);
  }
  ctx.ui.setWidget(WIDGET_ID, [
    ...(prepared.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
    ...renderSessionCard(active),
    modeLine(runtime),
    "读完后直接在下方开始讲这段学到了什么；不用按 F2。",
    ...(prepared.sandbox ? ["没读测试短文也可以输入：演示一下"] : []),
    "如果提前停下，可用 /learn stop 加实际末句缩短范围。",
    "迷路了输入“菜单”回到主菜单。",
  ]);
  ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：阅读中"));
  return active;
}

export default function readToOutputExtension(pi) {
  let displayPhase = null;
  let knowledgeReviewPending = null; // { item, phase: "prompted" | "recalling" }
  let knowledgeReviewDeclined = false;
  let lastReviewedItemId = null;

  async function startOrResumeBacktranslation(runtime, ctx) {
    let output = await readActiveBacktranslationSession(ctx.cwd);
    if (!output || output.phase === "completed") {
      if (output?.phase === "completed" && (output.kind ?? "new") === "new") {
        await registerFirstAttempt(runtime, output);
      }
      const preview = await previewBacktranslationSlot(runtime);
      let learning = null;
      if (!preview.item) {
        const current = await readActiveSession(ctx.cwd);
        learning = current?.phase === "verified"
          && (runtime.config.sandbox === true || current.archivedAt)
          ? current
          : await readLastVerifiedSession(ctx.cwd);
        if (!learning) learning = await recoverLastVerifiedSessionFromBackups(runtime);
        if (!learning) {
          throw new Error("请先完成并核对一个阅读分段，再开始回译");
        }
      }
      const opened = await openBacktranslationSlot(runtime);
      if (opened.item) {
        output = await startBacktranslationReview(runtime, opened.item, opened.currentSlot);
      } else {
        output = await startBacktranslation(runtime, learning, {
          outputSlot: opened.currentSlot,
          excludedSources: usedBacktranslationSources(opened.queue),
        });
      }
    }
    displayPhase = `backtranslation:${output.phase}`;
    ctx.ui.setWidget(WIDGET_ID, [
      ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
      ...renderBacktranslationCard(output),
    ]);
    ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", `学习系统：回译 ${output.phase}`));
    if (isBacktranslationModelPhase(output.phase)) {
      return {
        action: "transform",
        text: "继续当前回译阶段。严格执行系统中的回译阶段契约，不要把本句当作学习内容。",
      };
    }
    ctx.ui.notify(
      output.kind === "review" && output.phase === "answer"
        ? renderBacktranslationQuestion(output)
        : backtranslationPhaseGuidance(output),
      "info",
    );
    return { action: "handled" };
  }

  async function submitDemoStep(runtime, dashboard, ctx) {
    let active = await readActiveSession(ctx.cwd);
    if (!active || active.phase === "verified") {
      if (runtime.config.sandbox) {
        active = await chooseAndStartReading(runtime, dashboard, ctx, "sandbox-economics");
      } else {
        active = await startDemoReading(runtime);
      }
    }
    if (active.phase === "reading") {
      active = await transitionSession(runtime, "scope");
      displayPhase = active.phase;
    }
    if (active.phase === "scope") {
      const explanation = active.testExplanation?.trim();
      if (!explanation) throw new Error("沙盒段落缺少模拟讲述");
      await recordScopeExplanation(runtime, explanation);
      ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(active), "正在自动提交测试讲述…"]);
      pi.sendUserMessage(explanation);
      return;
    }
    if (active.phase === "feynman") {
      const answers = active.testAnswers ?? [];
      const answer = answers[Math.min(active.feynmanUserTurns.length, answers.length - 1)];
      if (!answer) throw new Error("沙盒段落缺少模拟回答");
      await recordFeynmanUserTurn(runtime, answer);
      pi.sendUserMessage(answer);
      return;
    }
    ctx.ui.notify("当前已进入核对阶段；请说“总结吧”。", "info");
  }

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType === "assistant"
      && context.isStreaming
      && displayPhase?.startsWith("backtranslation:")) {
      const phase = displayPhase.split(":")[1];
      const labels = {
        select: "正在生成回译题…",
        correct: "正在批改回译…",
        assess: "正在核对重写…",
      };
      if (labels[phase]) return labels[phase];
    }
    if (context.messageType === "assistant"
      && context.isStreaming
      && ["scope", "feynman"].includes(displayPhase)) {
      return "正在审核问题…";
    }
    return markdown;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (await isFirstRun(ctx.cwd)) {
        displayPhase = "onboarding";
        ctx.ui.setWidget(WIDGET_ID, [
          "📚 Read-to-Output｜英文原版书学习系统",
          "",
          "第一次使用，先做三件事：",
          "1. 确认 Obsidian 库路径（你的学习进度、费曼笔记、错题本都会存进这里）",
          "2. 配置模型 API（费曼提问、回译批改都靠它）",
          "3. 导入第一本电子书（EPUB / TXT）",
          "",
          "如果还没有 Obsidian：到 obsidian.md 免费下载安装，新建一个库即可。",
        ]);
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：首次设置"));
        const rawVault = await ctx.ui.input(
          "你的 Obsidian 库在哪个文件夹？（粘贴完整路径）",
          "例如：C:\\Users\\你\\Documents\\Obsidian Vault",
        );
        if (rawVault === undefined || !rawVault.trim()) {
          ctx.ui.notify("已取消首次设置。输入“开始设置”可以重新开始。", "info");
          return;
        }
        const vaultRoot = rawVault.trim().replace(/^["']|["']$/gu, "");
        try {
          const booted = await bootstrapRuntime(ctx.cwd, vaultRoot);
          let apiMessage = "";
          if (!(await isModelAvailable(ctx))) {
            const labels = API_PROVIDERS.map((provider) => provider.label);
            const chosen = await ctx.ui.select("选择模型服务商：", labels);
            if (chosen) {
              const provider = API_PROVIDERS[labels.indexOf(chosen)];
              const rawKey = await ctx.ui.input(
                `粘贴 ${provider.id} 的 API key（获取地址：${provider.url}，登录后在控制台创建）：`,
                "sk-...",
              );
              if (rawKey?.trim()) {
                try {
                  await storeApiKey(provider.id, rawKey);
                  apiMessage = `✅ ${provider.label} API key 已保存。`;
                } catch (apiError) {
                  apiMessage = `⚠ API key 保存失败：${translateUserError(apiError.message)}（可稍后手动配置）`;
                }
              } else {
                apiMessage = "⚠ 未提供 API key，可稍后用 /learn api 配置。";
              }
            } else {
              apiMessage = "⚠ 未配置模型，可稍后用 /learn api 配置。";
            }
          }
          ctx.ui.notify(
            [
              booted.progressCreated
                ? "已创建学习进度文件。"
                : "设置完成，检测到已有的学习进度文件。",
              apiMessage,
              "现在导入第一本书：输入 /learn add-book",
            ].filter(Boolean).join(" "),
            "info",
          );
          ctx.ui.setWidget(WIDGET_ID, [
            "✅ Obsidian 库已连接",
            `路径：${booted.vaultRoot}`,
            ...(apiMessage ? [apiMessage] : []),
            "",
            "下一步：导入第一本电子书",
            "输入：/learn add-book",
            "（支持 EPUB 和 TXT，会自动拆章并写入库）",
            "",
            "之后你会用到的：",
            "- 读完说“读完了”，讲完说“总结吧”",
            "- 输入“回译”练写作，说“我想记住：xxx”收藏知识点",
            "- 输入 /learn help 随时查看全部用法",
          ]);
        } catch (error) {
          ctx.ui.notify(`设置失败：${translateUserError(error.message)}`, "error");
        }
        return;
      }
      const runtime = await loadRuntime(ctx.cwd);
      if (runtime.config.runtime?.thinkingLevel) {
        pi.setThinkingLevel(runtime.config.runtime.thinkingLevel);
      }
      if (runtime.config.runtime?.lockModelTools) {
        pi.setActiveTools([]);
      }
      const active = await readActiveSession(ctx.cwd);
      await resumeReadingTimer(ctx.cwd);
      const output = await readActiveBacktranslationSession(ctx.cwd);

      // 未完成的回译是独占流程；重启后应直接恢复，不能先弹出无效的主菜单。
      if (output && output.phase !== "completed") {
        displayPhase = `backtranslation:${output.phase}`;
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", `学习系统：回译 ${output.phase}`));
        ctx.ui.setWidget(WIDGET_ID, [
          ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
          ...renderBacktranslationCard(output),
        ]);
        const guidance = isBacktranslationModelPhase(output.phase)
          ? `${backtranslationPhaseGuidance(output)} 输入“继续回译”恢复。`
          : backtranslationPhaseGuidance(output);
        ctx.ui.notify(guidance, "info");
        return;
      }

      if (!runtime.config.books.length) {
        displayPhase = "no-books";
        ctx.ui.setWidget(WIDGET_ID, [
          ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
          "📚 还没有电子书",
          "",
          "导入第一本书后就可以开始阅读：",
          "输入 /learn add-book",
          "（支持 EPUB 和 TXT，会自动拆章并写入库）",
        ]);
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：等待导入图书"));
        ctx.ui.notify("还没有书。输入 /learn add-book 导入第一本电子书。", "info");
        return;
      }

      // 非首次启动：弹出可选择的交互主菜单（↑↓ + 回车），第一项动态显示当前书
      let menuHandled = false;
      {
        displayPhase = "menu";
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：主菜单"));
        menuHandled = await showMenu(ctx);
      }

      let due = null;
      try {
        due = await dueKnowledgeItem(runtime);
      } catch {
        // 知识复习队列不可用时静默跳过，不影响主学习流程
      }
      if (due && !knowledgeReviewDeclined && !knowledgeReviewPending) {
        knowledgeReviewPending = { item: due, phase: "prompted" };
        ctx.ui.notify(
          "有一个你标记为想长期记住的点到期了，要花约 2 分钟回忆吗？回复“好”开始，回复“不用了”跳过。",
          "info",
        );
      }
      if (runtime.state.cadence?.nextSession === "mixed"
        || runtime.state.cadence?.nextSession === "mixed_pending"
        || runtime.state.cadence?.nextSession === "heavy_pending") {
        const heavy = runtime.state.cadence.nextSession === "heavy_pending";
        ctx.ui.notify(
          heavy
            ? "该做回译训练了（你选了重度模式，每次阅读后都要练）。输入“回译”开始。"
            : "读了两段了，该做一次回译训练了（把读过的内容从中文译回英文）。输入“回译”开始。",
          "info",
        );
      }
      if (runtime.config.sandbox === true && active?.phase === "verified") {
        displayPhase = active.phase;
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：沙盒核对完成"));
        ctx.ui.setWidget(WIDGET_ID, [
          "🧪 沙盒模式｜不会修改真实 Obsidian",
          ...renderSessionCard(active),
          "输入“回译”测试新的手动回译闭环。",
        ]);
        ctx.ui.notify("沙盒分段已经核对完成。现在可以直接输入“回译”。", "info");
        return;
      }
      const phase = active ? active.phase : "待开始";
      displayPhase = active?.phase ?? null;
      ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", `学习系统：${phase}`));
      const pendingRealArchive = active?.phase === "verified"
        && !active.archivedAt
        && runtime.config.sandbox !== true;
      if (active && (active.phase !== "verified" || pendingRealArchive)) {
        // 主菜单已在上面显示，这里不覆盖；只通过通知提供入口
        const guidance = active.phase === "reading"
          ? "继续阅读《" + active.bookName + "》" + active.segmentId + "：说“继续”或“今天学什么”。"
          : phaseGuidance(active);
        ctx.ui.notify(guidance, "info");
      } else if (!menuHandled) {
        ctx.ui.notify("主菜单已关闭；需要时输入“菜单”重新打开。", "info");
      }
    } catch (error) {
      ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("error", "学习系统：配置错误"));
      ctx.ui.notify(`Read-to-Output 加载失败：${translateUserError(error.message)}`, "error");
    }
  });

  pi.on("input", async (event, ctx) => {
    const text = event.text ?? "";
    try {
      const runtime = await loadRuntime(ctx.cwd);
      const active = await readActiveSession(ctx.cwd);
      const output = await readActiveBacktranslationSession(ctx.cwd);

      if (isBacktranslationRequest(text)) {
        return await startOrResumeBacktranslation(runtime, ctx);
      }

      if (output && output.phase !== "completed") {
        const btTrimmed = text.trim();
        if (/^(退出回译|取消回译|不练了|跳过回译|停止回译|回译退出)[。！! ]*$/u.test(btTrimmed)) {
          await cancelBacktranslation(runtime);
          ctx.ui.notify("已退出回译训练，没有损失任何进度。说“菜单”或继续阅读。", "info");
          return { action: "handled" };
        }
        if (output.phase === "answer") {
          if (!looksLikeEnglishAnswer(btTrimmed)) {
            ctx.ui.notify("请提交你的英文回译（刚才的中文题目译成英文）；不想练就输入“退出回译”。", "info");
            return { action: "handled" };
          }
          const updated = await recordBacktranslationAnswer(runtime, text);
          displayPhase = `backtranslation:${updated.phase}`;
          ctx.ui.setWidget(WIDGET_ID, renderBacktranslationCard(updated));
          return { action: "continue" };
        }
        if (output.phase === "rewrite") {
          if (!looksLikeEnglishAnswer(btTrimmed)) {
            ctx.ui.notify("请提交你的英文重写；不想练就输入“退出回译”。", "info");
            return { action: "handled" };
          }
          const updated = await recordBacktranslationRewrite(runtime, text);
          displayPhase = `backtranslation:${updated.phase}`;
          ctx.ui.setWidget(WIDGET_ID, renderBacktranslationCard(updated));
          return { action: "continue" };
        }
        ctx.ui.notify(`${backtranslationPhaseGuidance(output)} 输入“继续回译”恢复。`, "info");
        return { action: "handled" };
      }

      const rememberRequest = parseKnowledgeRememberRequest(text);
      if (knowledgeReviewPending) {
        if (knowledgeReviewPending.phase === "prompted") {
          if (isReviewAcceptRequest(text)) {
            knowledgeReviewPending.phase = "recalling";
            ctx.ui.setWidget(WIDGET_ID, [
              ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
              "知识复习｜凭记忆讲讲这个知识点",
              knowledgeReviewPending.item.content,
              "讲完直接发送即可。",
            ]);
            ctx.ui.notify("好，凭记忆讲讲这个知识点。", "info");
            return { action: "handled" };
          }
          if (isReviewDeclineRequest(text)) {
            knowledgeReviewDeclined = true;
            knowledgeReviewPending = null;
            ctx.ui.notify("好，先不复习，不影响继续阅读。", "info");
            return { action: "handled" };
          }
          if (isStopTrackingRequest(text)) {
            await stopKnowledgeItem(runtime, knowledgeReviewPending.item.id);
            knowledgeReviewPending = null;
            ctx.ui.notify("已停止追踪这个知识点。", "info");
            return { action: "handled" };
          }
          knowledgeReviewPending = null;
          knowledgeReviewDeclined = true;
        } else if (knowledgeReviewPending.phase === "recalling") {
          if (isStopTrackingRequest(text)) {
            await stopKnowledgeItem(runtime, knowledgeReviewPending.item.id);
            knowledgeReviewPending = null;
            ctx.ui.notify("已停止追踪这个知识点。", "info");
            return { action: "handled" };
          }
          const recall = text.trim();
          const judgment = await judgeKnowledgeRecall(ctx, knowledgeReviewPending.item, recall);
          if (judgment.decision === "unavailable") {
            ctx.ui.setWidget(WIDGET_ID, [
              ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
              "知识复习｜判分暂时不可用",
              "本次回答没有记成错误，也没有改变复习间隔。",
              "可以稍后重新发送回答，或说“不用了”先跳过。",
            ]);
            ctx.ui.notify("判分服务暂时不可用；本次不计错、不调整复习间隔。", "warning");
            return { action: "handled" };
          }
          const result = await reviewKnowledgeItem(
            runtime,
            knowledgeReviewPending.item.id,
            judgment.decision === "pass",
          );
          lastReviewedItemId = result.item.id;
          knowledgeReviewPending = null;
          const passed = judgment.decision === "pass";
          const label = result.item.status === "graduated" ? "毕业（不再追踪）" : nextReviewLabel(result.item);
          ctx.ui.setWidget(WIDGET_ID, [
            ...(runtime.config.sandbox ? ["🧪 沙盒模式｜不会修改真实 Obsidian"] : []),
            passed ? "✅ 回忆准确" : "❌ 这次没回忆对",
            `下次复习：${label}`,
            "回复“停止追踪”可以不再追踪这个知识点。",
          ]);
          ctx.ui.notify(
            passed ? "回忆准确，已按 3→7→14→30 天延长间隔。" : "没回忆准确，已退回上一级间隔。",
            "info",
          );
          return { action: "handled" };
        }
      }
      if (rememberRequest) {
        const source = knowledgeSourceFrom(active);
        if (rememberRequest.content) {
          const item = await addKnowledgeItem(runtime, { content: rememberRequest.content, source });
          ctx.ui.notify(`已记下：${item.content}（3 天后提醒复习）。`, "info");
          return { action: "handled" };
        }
        const content = await ctx.ui.input("想记住哪一点？请把这句话发给我。");
        if (content?.trim()) {
          const item = await addKnowledgeItem(runtime, { content: content.trim(), source });
          ctx.ui.notify(`已记下：${item.content}（3 天后提醒复习）。`, "info");
        }
        return { action: "handled" };
      }
      if (isStopTrackingRequest(text) && lastReviewedItemId) {
        await stopKnowledgeItem(runtime, lastReviewedItemId);
        lastReviewedItemId = null;
        ctx.ui.notify("已停止追踪这个知识点。", "info");
        return { action: "handled" };
      }

      if (/^(菜单|主菜单|menu|回主菜单|回到菜单)[？?。！! ]*$/iu.test(text.trim())) {
        await showMenu(ctx);
        return { action: "handled" };
      }

      if (isDemoRequest(text)) {
        await submitDemoStep(runtime, buildDashboard(runtime), ctx);
        return { action: "handled" };
      }

      if (isNaturalStartRequest(text)) {
        const dashboard = buildDashboard(runtime);
        if (isSwitchBookRequest(text)) {
          // 显式换书：即使目标书已有分段计划，也问一次“按分段 / 按时间”
          const started = await chooseAndStartReading(runtime, dashboard, ctx, "", {
            promptForMode: true,
            forceAskMode: true,
          });
          if (!started) ctx.ui.notify("已取消换书，当前学习状态没有改变。", "info");
          return { action: "handled" };
        }
        const pendingRealArchive = active?.phase === "verified"
          && !active.archivedAt
          && runtime.config.sandbox !== true;
        if (active && (active.phase !== "verified" || pendingRealArchive)) {
          ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(active), phaseGuidance(active)]);
          ctx.ui.notify(phaseGuidance(active), "info");
        } else {
          const continuing = isContinueRequest(text);
          const started = await chooseAndStartReading(runtime, dashboard, ctx, continuing
            ? active?.bookId ?? dashboard.lastBookId
            : "", {
            promptForMode: !continuing,
          });
          if (!started) ctx.ui.notify("已取消，本次没有开始新的阅读。", "info");
        }
        return { action: "handled" };
      }

      if (isReadingFinishedRequest(text)) {
        if (!active) {
          ctx.ui.notify("还没有开始阅读，先说“今天学什么”。", "info");
          return { action: "handled" };
        }
        if (active.phase === "reading") {
          const updated = await transitionSession(runtime, "scope");
          displayPhase = updated.phase;
          ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(updated), phaseGuidance(updated)]);
          ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：费曼讲述"));
          ctx.ui.notify("好，现在直接用自己的话讲这段学到了什么。", "info");
          return { action: "handled" };
        }
        if (active.phase === "scope" && active.scopeExplanation?.trim()) {
          const updated = await transitionSession(runtime, "feynman");
          displayPhase = updated.phase;
          ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(updated), phaseGuidance(updated)]);
          ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：费曼讲述"));
          return {
            action: "transform",
            text: [
              "恢复下方已经保存、且用户确认属于当前分段的讲述。请直接扮演困惑学生提出一个核心问题，不要要求用户重新讲述。",
              "<confirmed_user_explanation>",
              active.scopeExplanation,
              "</confirmed_user_explanation>",
            ].join("\n"),
            images: event.images,
          };
        }
        ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(active), phaseGuidance(active)]);
        ctx.ui.notify(phaseGuidance(active), "info");
        return { action: "handled" };
      }

      // 阅读完成后，用户可以直接开始费曼讲述；无需先输入“读完了”或按 F2。
      // scope 仍在后台完成范围核验，避免把读到后文的内容误存进当前分段。
      if (active?.phase === "reading" && text.trim() && !text.trim().startsWith("/")) {
        const updated = await transitionSession(runtime, "scope");
        await recordScopeExplanation(runtime, text);
        displayPhase = updated.phase;
        ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(updated), "正在核验讲述是否属于当前分段…"]);
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：费曼讲述"));
        return { action: "continue" };
      }

      if (active?.phase === "scope" && isScopeInOverride(text)) {
        const updated = await transitionSession(runtime, "feynman");
        displayPhase = updated.phase;
        ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：费曼讲述"));
        ctx.ui.notify("已人工确认范围，直接根据上一条完整讲述开始追问。", "info");
        return {
          action: "transform",
          text: active.scopeExplanation?.trim()
            ? [
                "用户确认下方缓存的讲述属于当前实际已读分段。请直接基于这段用户讲述开始费曼追问；不要要求用户重新讲述，也不要把本条恢复指令当作学习内容。",
                "<confirmed_user_explanation>",
                active.scopeExplanation,
                "</confirmed_user_explanation>",
              ].join("\n")
            : "用户确认上一条完整讲述属于当前实际已读分段。请直接基于上一条完整讲述开始费曼追问；不要要求用户重新讲述，也不要把本条确认当作学习内容。",
          images: event.images,
        };
      }

      if (!active && isVerificationRequest(text)) {
        ctx.ui.notify("还没有开始学习。先说“今天学什么”开始，或输入“菜单”查看全部操作。", "info");
        return { action: "handled" };
      }
      const completionRequested = active?.phase === "feynman"
        ? isFeynmanCompletionRequest(text)
        : isVerificationRequest(text);
      if (active?.phase === "scope" && !completionRequested) {
        await recordScopeExplanation(runtime, text);
        return { action: "continue" };
      }
      if (!completionRequested) {
        if (active?.phase === "feynman") await recordFeynmanUserTurn(runtime, text);
        return { action: "continue" };
      }
      if (["feynman", "verified"].includes(active?.phase)) {
        const updated = await transitionSession(runtime, "verify");
        displayPhase = updated.phase;
        ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
      }
    } catch (error) {
      ctx.ui.notify(`学习流程未能继续：${translateUserError(error.message)}`, "error");
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = await loadRuntime(ctx.cwd);
    const output = await readActiveBacktranslationSession(ctx.cwd);
    if (output && isBacktranslationModelPhase(output.phase)) {
      return {
        systemPrompt: await buildBacktranslationSystemPrompt(event.systemPrompt, output),
      };
    }
    const active = await readActiveSession(ctx.cwd);
    if (!active || !["scope", "feynman", "verify"].includes(active.phase)) return;
    return {
      systemPrompt: await buildPhaseSystemPrompt(event.systemPrompt, active, active.phase, {
        realWrite: runtime.config.writeMode === "real" && runtime.config.sandbox !== true,
      }),
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const runtime = await loadRuntime(ctx.cwd);
    const output = await readActiveBacktranslationSession(ctx.cwd);
    if (output && isBacktranslationModelPhase(output.phase)) {
      const candidateText = assistantText(event.message);
      try {
        if (output.phase === "select") {
          const result = await recordBacktranslationSelection(runtime, candidateText);
          displayPhase = `backtranslation:${result.session.phase}`;
          ctx.ui.setWidget(WIDGET_ID, renderBacktranslationCard(result.session));
          return { message: replaceAssistantText(event.message, result.visibleText) };
        }
        if (output.phase === "correct") {
          const result = await recordBacktranslationCorrection(runtime, candidateText);
          displayPhase = `backtranslation:${result.session.phase}`;
          const nextChoice = result.session.phase === "completed"
            ? await nextStudyChoice(ctx, result.session)
            : null;
          ctx.ui.setWidget(WIDGET_ID, [
            ...renderBacktranslationCard(result.session),
            ...(nextChoice ? ["", nextChoice] : []),
          ]);
          if (result.session.phase === "completed") {
            ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：回译完成"));
          }
          return {
            message: replaceAssistantText(
              event.message,
              [result.visibleText, nextChoice].filter(Boolean).join("\n\n"),
            ),
          };
        }
        const result = await finalizeBacktranslation(runtime, candidateText);
        displayPhase = `backtranslation:${result.session.phase}`;
        const nextChoice = await nextStudyChoice(ctx, result.session);
        ctx.ui.setWidget(WIDGET_ID, [
          ...renderBacktranslationCard(result.session),
          ...(nextChoice ? ["", nextChoice] : []),
        ]);
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：回译完成"));
        return {
          message: replaceAssistantText(
            event.message,
            [result.visibleText, nextChoice].filter(Boolean).join("\n\n"),
          ),
        };
      } catch (error) {
        if (output.phase === "select") {
          try {
            const result = await retryBacktranslationSelection(runtime, ctx, output, error);
            displayPhase = `backtranslation:${result.session.phase}`;
            ctx.ui.setWidget(WIDGET_ID, renderBacktranslationCard(result.session));
            ctx.ui.notify("选题格式异常，系统已自动重新生成。", "info");
            return { message: replaceAssistantText(event.message, result.visibleText) };
          } catch (retryError) {
            error = retryError;
          }
        }
        const safeMessages = {
          select: "这次选题在自动重试后仍未通过程序审核。请稍后回复“继续回译”再试一次。",
          correct: "这次批改格式没有通过程序审核，你的答案仍已保留。请回复“继续回译”重新批改。",
          assess: "这次重写核对格式没有通过程序审核，你的重写仍已保留。请回复“继续回译”重新核对。",
        };
        ctx.ui.notify(`回译阶段已安全拦截：${translateUserError(error.message)}`, "warning");
        ctx.ui.setWidget(WIDGET_ID, renderBacktranslationCard(output));
        return {
          message: replaceAssistantText(event.message, safeMessages[output.phase]),
        };
      }
    }
    const active = await readActiveSession(ctx.cwd);
    if (active?.phase === "verify") {
      const candidateText = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const normalized = normalizeVerificationSummary(candidateText, {
        sandbox: runtime.config.sandbox === true,
        real: runtime.config.writeMode === "real" && runtime.config.sandbox !== true,
        studentTurnsUsed: active.studentTurnsUsed,
      });
      if (normalized !== candidateText) {
        return { message: replaceAssistantText(event.message, normalized) };
      }
      return;
    }
    if (active?.phase === "feynman") {
      const candidateText = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const audit = await auditVisibleQuestion(ctx, active, candidateText);
      const updated = audit.passed ? await recordStudentTurn(runtime, audit.text) : active;
      ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
      if (audit.passed) return;
      return { message: replaceAssistantText(event.message, audit.text) };
    }
    if (active?.phase !== "scope") return;

    const textBlocks = event.message.content.filter((block) => block.type === "text");
    const text = textBlocks.map((block) => block.text).join("\n");
    const decision = parseScopeDecision(text);
    let visibleText;

    if (decision === "in") {
      const feynman = await transitionSession(runtime, "feynman");
      displayPhase = feynman.phase;
      const candidateText = stripScopeDecisionMarker(text) || "范围匹配。请继续讲清楚本段的核心逻辑。";
      const audit = await auditVisibleQuestion(ctx, feynman, candidateText);
      if (audit.passed) await recordStudentTurn(runtime, audit.text);
      visibleText = audit.text;
    } else if (decision === "out") {
      visibleText = "你讲的内容似乎不属于当前分段。你是继续读到了后面，还是在补充前文背景？";
    } else {
      visibleText = "范围核验没有按格式返回。若你确认刚才讲的就是当前段，请回复：这是当前段。";
    }

    return {
      message: replaceAssistantText(event.message, visibleText),
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    try {
      const runtime = await loadRuntime(ctx.cwd);
      const active = await readActiveSession(ctx.cwd);
      if (active?.phase === "verify") {
        const updated = await transitionSession(runtime, "verified");
        const latestSummary = [...(event.messages ?? [])]
          .reverse()
          .find((message) => message.role === "assistant")
          ?.content
          ?.filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n") ?? "";
        const normalizedSummary = normalizeVerificationSummary(latestSummary, {
          sandbox: runtime.config.sandbox === true,
          real: runtime.config.writeMode === "real" && runtime.config.sandbox !== true,
          studentTurnsUsed: updated.studentTurnsUsed,
        });
        const finalized = await finalizeLearningSession(
          runtime,
          updated,
          normalizedSummary,
          extractNoteTitle(normalizedSummary),
        );
        const archived = await markSessionArchived(runtime, finalized);
        if (finalized.demo === true) {
          displayPhase = "demo-done";
          ctx.ui.setWidget(WIDGET_ID, [
            "🎬 演示完成！这就是一次完整的学习流程：",
            "阅读 → 讲给 AI 听（费曼）→ 原文核对 → 自动存档",
            "",
            "刚才的演示内容没有写入任何笔记，你的库是干净的。",
            "现在可以开始真正学习了：",
            "1. 输入 /learn add-book 导入第一本电子书",
            "2. 或说“今天学什么”开始",
            "3. 随时输入 /learn help 查看用法",
          ]);
          ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：演示完成"));
          ctx.ui.notify("演示完成！没有写入任何笔记。输入 /learn add-book 导入你的第一本书吧。", "info");
          try {
            await rm(path.join(runtime.runtimeRoot, "active-session.json"), { force: true });
          } catch { /* 清理失败不影响演示完成提示 */ }
          return;
        }
        displayPhase = archived.phase;
        const advanced = finalized.advancedTo;
        ctx.ui.setWidget(WIDGET_ID, [
          ...(finalized.sandbox ? ["🧪 沙盒存档完成｜真实 Obsidian 未修改"] : []),
          ...(finalized.real ? ["✅ 正式存档完成｜已创建写入前备份"] : []),
          ...(finalized.noteTitle ? [`本次笔记：${finalized.noteTitle}`] : []),
          ...renderSessionCard(archived),
          ...(finalized.sandbox || finalized.real
            ? [
                advanced
                  ? `🎉 本章完成！已自动推进到第 ${advanced.chapterNumber} 章（${advanced.chapterTitle}），下次将自动规划`
                  : `下一段：${finalized.nextSegmentId ?? "本章完成（已是最后一章）"}`,
              ]
            : []),
        ]);
        ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", "学习系统：核对完成"));
        if (runtime.state.cadence?.backtranslationMode === "heavy") {
          // 重度模式：每次阅读核对后必做回译，直接进入回译会话（未完成会被流程拦截）
          try {
            await startOrResumeBacktranslation(runtime, ctx);
          } catch (backtranslationError) {
            ctx.ui.notify(`重度模式回译未能自动开始：${translateUserError(backtranslationError.message)}`, "warning");
          }
        }
        const completedChapter = finalized.nextSegmentId === null && !archived.remainingStartAnchor;
        if (completedChapter) {
          try {
            const completedBook = {
              bookId: archived.bookId,
              bookName: archived.bookName,
              chapterNumber: archived.chapterNumber,
              chapterTitle: archived.chapterTitle,
            };
            const notes = await collectChapterNotes(runtime, completedBook);
            if (notes.length) {
              const synthesisPath = await synthesizeChapter(ctx, runtime, completedBook, notes);
              ctx.ui.notify(
                `本章章节骨架已自动生成：${path.basename(synthesisPath)}（基于你的费曼笔记，可随时查看）`,
                "info",
              );
            }
          } catch (synthesisError) {
            // 章节串联失败不影响存档结果，仅静默记录
            ctx.ui.notify(`章节骨架生成跳过：${synthesisError.message}`, "info");
          }
        }
      }
    } catch (error) {
      ctx.ui.notify(`核对结果状态未能更新：${translateUserError(error.message)}`, "warning");
    }
  });

  const showHelp = (ctx) => {
    ctx.ui.setWidget(WIDGET_ID, [
      "📚 Read-to-Output｜使用说明",
      "",
      "【一次完整的学习流程】",
      "1. 说“今天学什么”或“继续” → 选书开始阅读",
      "2. 读完后直接开始讲这段学到了什么（也可输入“读完了”）",
      "3. AI 核验范围后进入费曼追问",
      "4. 讲完说“总结吧”（或按 F2）→ 系统核对原文并自动存档",
      "5. 重复直到本章完成，系统会自动推进到下一章",
      "",
      "【随时可用的话】",
      "- “继续” / “换一本” —— 续读 / 换书",
      "- “回译” —— 把读过的内容从中文译回英文（写作训练）",
      "- “我想记住：……” —— 只把你主动选择的知识点加入复习队列",
      "- “停止追踪” —— 不再提醒某个记忆点",
      "- “演示一下” —— 沙盒模式自动走一遍流程",
      "",
      "【快捷键】",
      "- F2 / Ctrl+Shift+Enter —— 阅读中直接进入讲述；其他阶段提供快捷下一步",
      "- F3 —— 撤回上一步（误操作时用）",
      "",
      "【菜单交互】",
      "- 读完后直接在输入框讲即可；无需按 F2",
      "- 输入“菜单”也会弹出可选主菜单",
      "",
      "【命令】",
      "- /mode —— 切换回译模式（off 纯阅读 / light 轻量 / heavy 重度）",
      "- /add-book —— 导入电子书（EPUB / TXT）",
      "- /learn api —— 配置或更换模型 API key",
      "- /learn session —— 查看当前进度",
      "- /learn complete —— 手动标记当前分段已读（跳过费曼，需确认）",
      "- /learn diagnose —— 查看系统诊断信息",
      "- /help —— 随时查看本说明",
      "",
      "【提示】",
      "- 迷路了随时输入“菜单”回到主菜单",
      "- 学习进度、费曼笔记、错题本都存在你的 Obsidian 库里",
      "- 卡片上显示的内容就是当前状态，跟着提示走就行",
    ]);
    ctx.ui.notify("已显示使用说明。输入 /learn help 可随时查看。", "info");
  };

  // F2 弹出的"下一步"菜单：方向键选择 + 回车确认
  async function showNextStepMenu(ctx) {
    const runtime = await loadRuntime(ctx.cwd);
    const btOutput = await readActiveBacktranslationSession(ctx.cwd);
    if (btOutput && btOutput.phase !== "completed") {
      ctx.ui.notify("正在回译训练：请直接输入你的英文回译；想退出就输入“退出回译”。", "info");
      return;
    }
    const active = await readActiveSession(ctx.cwd);
    if (!active) {
      const choice = await ctx.ui.select("下一步做什么？", [
        "▶ 开始阅读 / 继续学习（最近的书）",
        "回译训练",
        "查看主菜单",
      ]);
      if (!choice) return;
      if (choice.startsWith("▶")) {
        pi.sendUserMessage("继续");
      } else if (choice.includes("回译")) {
        pi.sendUserMessage("回译");
      } else {
        await showMenu(ctx);
      }
      return;
    }
    if (active.phase === "reading") {
      pi.sendUserMessage("读完了");
      return;
    }
    if (active.phase === "scope" || active.phase === "feynman") {
      const choice = await ctx.ui.select("讲完了吗？", [
        "▶ 讲完了，开始原文核对",
        "回主菜单",
      ]);
      if (!choice) return;
      if (choice.startsWith("▶")) pi.sendUserMessage("总结吧");
      else await showMenu(ctx);
      return;
    }
    if (active.phase === "verified") {
      const choice = await ctx.ui.select("下一步做什么？", [
        "▶ 继续下一段",
        "回译训练",
        "查看主菜单",
      ]);
      if (!choice) return;
      if (choice.startsWith("▶")) pi.sendUserMessage("继续");
      else if (choice.includes("回译")) pi.sendUserMessage("回译");
      else await showMenu(ctx);
      return;
    }
    ctx.ui.notify(`当前阶段（${active.phase}）不需要菜单操作。`, "info");
  }

  const advanceHandler = async (ctx) => {
    try {
      await showNextStepMenu(ctx);
    } catch (error) {
      ctx.ui.notify(`快捷键推进失败：${translateUserError(error.message)}`, "error");
    }
  };

  // Ctrl+Enter 在多数终端无法与普通回车区分，改用终端可靠识别的 F2 / Ctrl+Shift+Enter
  pi.registerShortcut("f2", {
    description: "快捷推进（阅读完成 / 费曼总结）",
    handler: advanceHandler,
  });
  pi.registerShortcut("ctrl+shift+enter", {
    description: "快捷推进（阅读完成 / 费曼总结）",
    handler: advanceHandler,
  });

  pi.registerShortcut("f3", {
    description: "撤回上一步推进（误按 F2 时恢复）",
    handler: async (ctx) => {
      try {
        const runtime = await loadRuntime(ctx.cwd);
        const active = await readActiveSession(ctx.cwd);
        if (!active) {
          ctx.ui.notify("当前没有进行中的学习场。", "info");
          return;
        }
        const reverted = await regressSession(runtime);
        displayPhase = reverted.phase;
        const labels = { reading: "阅读中", scope: "讲述范围核验", feynman: "费曼讲述", verify: "原文核对中" };
        ctx.ui.setWidget(WIDGET_ID, [...renderSessionCard(reverted), `已撤回一步，回到：${labels[reverted.phase]}`]);
        ctx.ui.notify(`已撤回上一步（${labels[reverted.phase]}）。`, "info");
      } catch (error) {
        ctx.ui.notify(`撤回失败：${translateUserError(error.message)}`, "warning");
      }
    },
  });

  // 顶层命令：覆盖 pi 内置的 /help，并给常用操作提供快捷入口
  async function runModeCommand(ctx, requested = "") {
    const runtime = await loadRuntime(ctx.cwd);
    const currentMode = normalizeBacktranslationMode(runtime.state.cadence?.backtranslationMode);
    let selected = null;
    if (requested) {
      selected = BACKTRANSLATION_MODES.find((mode) => mode === requested.toLowerCase()) ?? null;
      if (!selected) {
        ctx.ui.notify(`未知模式：${requested}（可用：off / light / heavy）`, "warning");
        return { changed: false, cancelled: false, invalid: true };
      }
    } else {
      const labels = [
        `纯阅读（不安排回译）${currentMode === "off" ? " ← 当前" : ""}`,
        `轻量（两次阅读，一次回忆）${currentMode === "light" ? " ← 当前" : ""}`,
        `重度（每次阅读后必做回译）${currentMode === "heavy" ? " ← 当前" : ""}`,
      ];
      const chosen = await ctx.ui.select("选择回译模式：", labels);
      if (!chosen) return { changed: false, cancelled: true };
      selected = BACKTRANSLATION_MODES[labels.indexOf(chosen)];
    }
    await persistBacktranslationMode(runtime, selected);
    ctx.ui.notify(`回译模式已切换为：${backtranslationModeLabel(selected)}。`, "info");
    return { changed: true, selected };
  }

  function showModeSummary(ctx, selected) {
    ctx.ui.setWidget(WIDGET_ID, [
      "✅ 回译模式已切换",
      `当前：${backtranslationModeLabel(selected)}`,
      "",
      "输入“菜单”返回主菜单，或输入“继续”接着学习。",
    ]);
  }

  function showImportedBook(ctx, imported) {
    ctx.ui.setWidget(WIDGET_ID, [
      `📚 已导入《${imported.bookName}》`,
      `章节数：${imported.chapterCount}`,
      `章节目录：${imported.chapterDirectory}`,
      "输入“今天学什么”选择这本书开始阅读，或输入“菜单”返回主菜单。",
    ]);
  }

  async function runManualCompleteCommand(ctx) {
    const runtime = await loadRuntime(ctx.cwd);
    if (runtime.config.sandbox === true) {
      ctx.ui.notify("沙盒不需要手动完成真实分段；直接继续测试即可。", "info");
      return;
    }
    const active = await readActiveSession(ctx.cwd);
    if (active && !active.archivedAt) {
      ctx.ui.notify("当前分段已有进行中的阅读或费曼流程；请正常完成，或先用 /learn stop 缩短范围。", "warning");
      return;
    }
    const bookId = runtime.state.lastBookId;
    const book = bookId ? runtime.state.books[bookId] : null;
    if (!book?.nextSegment) {
      ctx.ui.notify("当前没有等待完成的阅读分段。", "info");
      return;
    }
    const bookName = runtime.config.books.find((item) => item.id === bookId)?.name ?? "当前书";
    const confirmed = await ctx.ui.select(
      `确认把《${bookName}》${book.nextSegment.id} 标为已读吗？不会生成费曼笔记。`,
      ["确认完成", "取消"],
    );
    if (confirmed !== "确认完成") return;
    const result = await completeRealSegmentWithoutFeynman(runtime, bookId);
    const advanced = result.advancedTo;
    ctx.ui.setWidget(WIDGET_ID, [
      `✅ ${result.completedSegmentId} 已标为已读（未做费曼）`,
      advanced
        ? `第${advanced.chapterNumber}章 ${advanced.chapterTitle} 已待开始；下次选择“按分段”才会生成计划。`
        : result.nextSegmentId
          ? `下一段：${result.nextSegmentId}`
          : "本章已完成。",
      "输入“继续”开始下一步，或输入“菜单”选择别的学习。",
    ]);
    ctx.ui.notify("已安全保存，并创建写入前备份。", "info");
  }

  async function runAddBookCommand(ctx) {
    const runtime = await loadRuntime(ctx.cwd);
    const rawPath = await ctx.ui.input("电子书文件路径（EPUB 或 TXT）：", "例如：C:\\Users\\你\\Downloads\\book.epub");
    if (rawPath === undefined) return { imported: null, cancelled: true };
    const filePath = rawPath.trim().replace(/^["']|["']$/gu, "");
    if (!filePath) {
      ctx.ui.notify("未提供文件路径，已取消。", "info");
      return { imported: null, cancelled: true };
    }
    const rawName = await ctx.ui.input("这本书叫什么名字？（可留空自动从文件识别）", "例如：经济学原理");
    const bookName = rawName?.trim() || undefined;
    try {
      const imported = await importBook(runtime, { filePath, bookName });
      ctx.ui.notify(`《${imported.bookName}》已导入（${imported.chapterCount} 章），可以开始读了。`, "info");
      return { imported, cancelled: false };
    } catch (error) {
      ctx.ui.notify(`导入失败：${translateUserError(error.message)}`, "error");
      return { imported: null, cancelled: false, error };
    }
  }

  const showMenu = async (ctx) => {
    while (true) {
      const runtime = await loadRuntime(ctx.cwd);
      const active = await readActiveSession(ctx.cwd);
      const firstLabel = !active
        ? "▶ 开始阅读 / 继续学习（最近的书）"
        : active.phase === "reading"
          ? `▶ 继续阅读《${active.bookName}》${active.segmentId}`
          : active.phase === "scope" || active.phase === "feynman"
            ? `▶ 继续费曼讲述《${active.bookName}》${active.segmentId}`
            : active.phase === "verify"
              ? `▶ 继续原文核对《${active.bookName}》${active.segmentId}`
              : `▶ 继续下一段《${active.bookName}》`;
      const currentMode = normalizeBacktranslationMode(runtime.state.cadence?.backtranslationMode);
      const modeLabel = backtranslationModeLabel(currentMode);
      ctx.ui.setWidget(WIDGET_ID, [
        "📋 Read-to-Output｜主菜单",
        "",
        "用 ↑↓ 选择，回车确认：",
        firstLabel,
        "换一本书 · 回译训练 · 导入新书 · 切换模式 · 测试流程（演示一下） · 使用说明",
        `当前回译模式：${modeLabel}`,
        "",
        "也可以直接说：继续 / 换一本 / 回译 / 菜单",
      ]);
      const choice = await ctx.ui.select("📋 主菜单（↑↓ 选择，回车确认）", [
        firstLabel,
        "换一本书",
        "回译训练",
        "导入新书（/add-book）",
        `切换回译模式（当前：${modeLabel}）`,
        "测试流程（不碰真实进度）",
        "使用说明（/help）",
      ]);
      if (!choice) {
        ctx.ui.setWidget(WIDGET_ID, [
          "📋 Read-to-Output｜主菜单已关闭",
          firstLabel,
          ...(active ? renderSessionCard(active) : []),
          "快捷操作：换一本书 · 回译训练 · 测试流程（演示一下）",
          "输入“菜单”可重新打开。",
        ]);
        return false;
      }
      if (choice.startsWith("▶")) {
        pi.sendUserMessage("继续");
        return true;
      }
      if (choice.includes("换一本书")) {
        const started = await chooseAndStartReading(runtime, buildDashboard(runtime), ctx, "", {
          promptForMode: true,
          forceAskMode: true,
        });
        if (started) return true;
        ctx.ui.notify("已取消换书，返回主菜单。", "info");
        continue;
      }
      if (choice.includes("回译训练")) {
        pi.sendUserMessage("回译");
        return true;
      }
      if (choice.includes("测试流程")) {
        pi.sendUserMessage("演示一下");
        return true;
      }
      if (choice.includes("切换回译模式")) {
        await runModeCommand(ctx);
        continue;
      }
      if (choice.includes("导入")) {
        await runAddBookCommand(ctx);
        continue;
      }
      showHelp(ctx);
      await ctx.ui.select("使用说明", ["返回主菜单"]);
    }
  };

  pi.registerCommand("menu", {
    description: "Read-to-Output 主菜单",
    handler: async (_args, ctx) => {
      await showMenu(ctx);
    },
  });
  pi.registerCommand("help", {
    description: "Read-to-Output 使用说明",
    handler: async (_args, ctx) => {
      showHelp(ctx);
    },
  });
  pi.registerCommand("mode", {
    description: "切换回译模式（off / light / heavy）",
    handler: async (_args, ctx) => {
      const result = await runModeCommand(ctx);
      if (result?.changed) showModeSummary(ctx, result.selected);
    },
  });
  pi.registerCommand("add-book", {
    description: "导入电子书（EPUB / TXT）",
    handler: async (_args, ctx) => {
      const result = await runAddBookCommand(ctx);
      if (result?.imported) showImportedBook(ctx, result.imported);
    },
  });

  pi.registerCommand("learn", {
    description: "查看进度并运行阅读、费曼讲述和原文核对",
    getArgumentCompletions: (prefix) => {
      const values = [
        "help",
        "start",
        "feynman",
        "verify",
        "backtranslation",
        "mode",
        "mode off",
        "mode light",
        "mode heavy",
        "api",
        "add-book",
        "session",
        "complete",
        "demo",
        "diagnose",
        "clear",
      ];
      const matched = values.filter((value) => value.startsWith(prefix));
      return matched.length ? matched.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "clear") {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        return;
      }

      if (command === "help" || command === "?" || command === "") {
        showHelp(ctx);
        return;
      }

      try {
        const runtime = await loadRuntime(ctx.cwd);
        const dashboard = buildDashboard(runtime);

        if (command === "api" || command.startsWith("api ")) {
          const available = await isModelAvailable(ctx);
          if (available) {
            ctx.ui.notify("当前模型已经配置好 API key，无需重复设置。", "info");
            return;
          }
          const labels = API_PROVIDERS.map((provider) => provider.label);
          const chosen = await ctx.ui.select("选择模型服务商：", labels);
          if (!chosen) return;
          const provider = API_PROVIDERS[labels.indexOf(chosen)];
          const rawKey = await ctx.ui.input(
            `粘贴 ${provider.id} 的 API key（可在官网控制台获取）：`,
            "sk-...",
          );
          if (!rawKey?.trim()) {
            ctx.ui.notify("未提供 API key，已取消。", "info");
            return;
          }
          try {
            await storeApiKey(provider.id, rawKey);
            ctx.ui.notify(`✅ ${provider.label} API key 已保存。重启后生效。`, "info");
          } catch (apiError) {
            ctx.ui.notify(`保存失败：${translateUserError(apiError.message)}`, "error");
          }
          return;
        }

        if (command === "mode" || command.startsWith("mode ")) {
          const requested = command.slice("mode".length).trim();
          const result = await runModeCommand(ctx, requested);
          if (result?.changed) showModeSummary(ctx, result.selected);
          return;
        }

        if (command === "add-book" || command === "add") {
          const result = await runAddBookCommand(ctx);
          if (result?.imported) showImportedBook(ctx, result.imported);
          return;
        }

        if (command === "demo") {
          await submitDemoStep(runtime, dashboard, ctx);
          return;
        }

        if (command === "backtranslation" || command === "bt") {
          pi.sendUserMessage("回译");
          return;
        }

        if (command === "session") {
          const active = await readActiveSession(ctx.cwd);
          if (!active) {
            ctx.ui.notify("当前没有进行中的学习场。", "info");
            return;
          }
          ctx.ui.setWidget(WIDGET_ID, renderSessionCard(active));
          return;
        }

        if (command === "complete") {
          await runManualCompleteCommand(ctx);
          return;
        }

        if (command === "feynman") {
          const active = await readActiveSession(ctx.cwd);
          if (!active) {
            ctx.ui.notify("还没有开始阅读，先说“今天学什么”。", "info");
            return;
          }
          const updated = active.phase === "reading"
            ? await transitionSession(runtime, "scope")
            : active;
          displayPhase = updated.phase;
          ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
          ctx.ui.setStatus("read-to-output", ctx.ui.theme.fg("accent", `学习系统：${updated.phase}`));
          ctx.ui.notify(phaseGuidance(updated), "info");
          return;
        }

        if (command === "verify") {
          const updated = await transitionSession(runtime, "verify");
          displayPhase = updated.phase;
          ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
          pi.sendUserMessage("现在请退出学生角色，按照核对规则总结并核对我刚才的讲述。");
          return;
        }

        if (command === "stop" || command.startsWith("stop ")) {
          const updated = await trimSessionAtEnd(runtime, command.slice("stop".length));
          ctx.ui.setWidget(WIDGET_ID, renderSessionCard(updated));
          ctx.ui.notify(`实际阅读终点已缩短到 ${updated.sourceWords} 词。`, "info");
          return;
        }

        if (command === "start" || command.startsWith("start ")) {
          const query = command.slice("start".length).trim();
          await chooseAndStartReading(runtime, dashboard, ctx, query);
          return;
        }

        if (command === "diagnose") {
          const active = await readActiveSession(ctx.cwd);
          const lastVerified = await readLastVerifiedSession(ctx.cwd);
          const output = await readActiveBacktranslationSession(ctx.cwd);
          const knowledgeQueue = await readKnowledgeQueue(runtime);
          const activeItems = knowledgeQueue.items.filter((item) => item.status === "active");
          const due = await dueKnowledgeItem(runtime);
          const lines = [
            "Read-to-Output 诊断",
            `程序版本：${BUILD_VERSION}`,
            `结构化配置：${dashboard.metrics.configBytes} bytes`,
            `结构化状态：${dashboard.metrics.stateBytes} bytes`,
            `基础启动状态：${dashboard.metrics.totalRuntimeBytes} bytes`,
            "学习进度正文：未读取",
            "章节正文：未读取",
            `状态快照：${dashboard.freshness.status}`,
            `当前学习场：${active?.phase ?? "无"}`,
            `最近核对分段：${lastVerified ? `${lastVerified.bookName} ${lastVerified.segmentId}` : "无"}`,
            `当前回译场：${output?.phase ?? "无"}`,
            `知识复习队列：${activeItems.length} 项待复习，${knowledgeQueue.items.length - activeItems.length} 项已结束`,
            `最近到期项：${due ? due.content.slice(0, 40) : "无"}`,
            active
              ? `已读原文缓存：${active.sourceWords} 词，仅本地校验；本次尚未发送给模型`
              : "已读原文缓存：无",
          ];
          ctx.ui.setWidget(WIDGET_ID, lines);
          return;
        }

        let selectedBook = command ? findBook(dashboard, command) : null;
        if (command && !selectedBook) {
          ctx.ui.notify(`无法唯一匹配图书：${command}`, "warning");
          return;
        }

        if (!selectedBook && dashboard.books.length > 1) {
          const labels = dashboard.books.map(selectorLabel);
          const selectedLabel = await ctx.ui.select("今天读哪本？", labels);
          if (!selectedLabel) return;
          selectedBook = dashboard.books[labels.indexOf(selectedLabel)];
        }
        selectedBook ??= dashboard.books[0];

        ctx.ui.setWidget(WIDGET_ID, renderBookCard(selectedBook, dashboard));
        if (dashboard.freshness.status !== "current") {
          ctx.ui.notify(dashboard.freshness.reason, "warning");
        }
      } catch (error) {
        ctx.ui.notify(`无法读取学习状态：${translateUserError(error.message)}`, "error");
      }
    },
  });
}
