const PLAN_ANCHORS = /\s*<!--\s*RTO_ANCHORS:([A-Za-z0-9_-]+)\s*-->/u;
const VISIBLE_ANCHORS = /(\|\s*起\s*["“])(.*?)(["”]\s*止\s*["“])(.*?)(["”])/u;

function shorten(text, limit = 240) {
  return text.length > limit ? `${text.slice(0, limit - 3).trimEnd()}...` : text;
}

function sentences(text) {
  const candidates = String(text ?? "")
    .trim()
    .match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu) ?? [];
  return candidates.map((candidate) => candidate.trim()).filter(Boolean);
}

export function readablePlanAnchor(anchor, { fromEnd = false } = {}) {
  const candidates = sentences(anchor);
  const meaningful = candidates.filter((candidate) => candidate.split(/\s+/u).length >= 4);
  const selected = fromEnd
    ? (meaningful.at(-1) ?? candidates.at(-1) ?? String(anchor ?? "").trim())
    : (meaningful[0] ?? candidates[0] ?? String(anchor ?? "").trim());
  return shorten(selected);
}

export function readPlanAnchors(line) {
  const encoded = String(line ?? "").match(PLAN_ANCHORS)?.[1];
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof parsed.startAnchor !== "string" || typeof parsed.endAnchor !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function withPlanAnchors(line, startAnchor, endAnchor) {
  const clean = String(line ?? "").replace(PLAN_ANCHORS, "").trimEnd();
  const encoded = Buffer.from(JSON.stringify({ startAnchor, endAnchor }), "utf8").toString("base64url");
  return `${clean} <!--RTO_ANCHORS:${encoded}-->`;
}

export function rewritePlanPresentation(progress, { forceOrdinary = false } = {}) {
  return String(progress ?? "").split(/\r?\n/u).map((line) => {
    if (!/^- \[[ x~]\] /u.test(line) || !VISIBLE_ANCHORS.test(line)) return line;
    const visible = line.match(VISIBLE_ANCHORS);
    const stored = readPlanAnchors(line);
    const startAnchor = stored?.startAnchor ?? visible[2];
    const endAnchor = stored?.endAnchor ?? visible[4];
    let updated = line.replace(
      VISIBLE_ANCHORS,
      `$1${readablePlanAnchor(startAnchor)}$3${readablePlanAnchor(endAnchor, { fromEnd: true })}$5`,
    );
    if (forceOrdinary) updated = updated.replace("（混合场）", "");
    return withPlanAnchors(updated, startAnchor, endAnchor);
  }).join("\n");
}
