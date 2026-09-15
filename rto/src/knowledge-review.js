const JUDGE_SYSTEM_PROMPT = `你是记忆复习审核器。用户曾经标记一个知识点为"想长期记住"，现在凭记忆回忆它。

输入：
<knowledge_point> 用户当初标记想长期记住的知识点 </knowledge_point>
<user_recall> 用户本次凭记忆的回忆复述 </user_recall>

判断用户的回忆是否抓住了该知识点的核心。允许措辞不同、细节有出入，只要核心内容（概念、机制、结论）准确即可 PASS。明显错误、核心缺失或答非所问则 REJECT。

只输出一个单词：PASS 或 REJECT。`;

export function buildRecallJudgeContext(item, recallText) {
  return [
    "<knowledge_point>",
    item.content,
    "</knowledge_point>",
    "",
    "<user_recall>",
    recallText.trim() || "（用户没有回忆出内容）",
    "</user_recall>",
  ].join("\n");
}

export function parseRecallJudgeDecision(text) {
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

export async function judgeKnowledgeRecall(ctx, item, recallText) {
  if (!ctx.model || typeof ctx.modelRegistry?.complete !== "function") {
    return { decision: "unavailable", reason: "judge-unavailable" };
  }
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildRecallJudgeContext(item, recallText),
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
    const decision = parseRecallJudgeDecision(extractAssistantText(response));
    return { decision: decision ?? "unavailable", reason: decision ? undefined : "invalid-judge-output" };
  } catch (error) {
    return { decision: "unavailable", reason: error.message };
  }
}
