const AUDIT_SYSTEM_PROMPT = `你是费曼提问的独立边界审核器。你不回答问题，也不改写问题，只输出 PASS 或 REJECT。

判定 PASS 必须同时满足：
1. 候选输出若包含知识性追问，追问对象来自用户已经讲出的内容；
2. 用户回答该追问所需的事实、因果机制或关系，在 actual_read_source 中有明确文字依据；
3. 不需要后文、前文未提供的背景知识或外部常识才能回答；
4. 不是记忆测验，也不要求回忆姓名、日期、条款、列表或被用户遗漏的原文细节。

以下情况必须 REJECT：
- 原文只陈述 X，但问题追问“为什么 X”“什么机制导致 X”，而本段没有解释机制；
- 问题虽然与主题相关，但答案在后文、其他章节或外部知识中；
- 候选输出把自己的推论塞进问题，再让用户确认；
- 用户没有讲到该点，问题只是因为原文出现过它而要求补充。

纯流程性询问（例如“还有补充吗，还是我来总结？”）可以 PASS。
只输出一个单词：PASS 或 REJECT。`;

export const REJECTED_QUESTION_MESSAGE =
  "这个问题需要当前分段没有提供的解释，我不追问了。还有补充吗，还是我来总结？";

export function buildQuestionAuditContext(session, candidateText) {
  const userTurns = [
    session.scopeExplanation?.trim(),
    ...(Array.isArray(session.feynmanUserTurns) ? session.feynmanUserTurns : []),
  ].filter(Boolean);
  return [
    "<actual_read_source>",
    session.sourceText,
    "</actual_read_source>",
    "",
    "<user_explanation_so_far>",
    userTurns.join("\n\n---\n\n") || "（无）",
    "</user_explanation_so_far>",
    "",
    "<candidate_output>",
    candidateText,
    "</candidate_output>",
  ].join("\n");
}

export function parseQuestionAuditDecision(text) {
  const decision = text
    .split(/\r?\n/u)
    .map((line) => line.trim().toUpperCase())
    .find(Boolean);
  if (decision === "PASS") return "pass";
  if (decision === "REJECT") return "reject";
  return null;
}

function extractAssistantText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export async function auditFeynmanOutput(ctx, session, candidateText) {
  if (!ctx.model || typeof ctx.modelRegistry?.complete !== "function") {
    return { decision: "reject", reason: "auditor-unavailable" };
  }
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: AUDIT_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildQuestionAuditContext(session, candidateText),
          timestamp: Date.now(),
        }],
        tools: [],
      },
      {
        maxTokens: 32,
        temperature: 0,
        signal: ctx.signal,
      },
    );
    const decision = parseQuestionAuditDecision(extractAssistantText(response));
    return { decision: decision ?? "reject", reason: decision ? undefined : "invalid-audit-output" };
  } catch (error) {
    return { decision: "reject", reason: error.message };
  }
}
