function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (true) {
    const found = text.indexOf(needle, cursor);
    if (found === -1) return count;
    count += 1;
    cursor = found + needle.length;
  }
}

/**
 * 电子书转换常会把普通撇号变成排版撇号。定位锚点时兼容这一种
 * 无语义的排版差异，但仍要求全文中唯一命中，避免模糊匹配到错误段落。
 */
export function normalizeAnchorTypography(text) {
  return String(text).replace(/[\u0027\u2018\u2019\u02BC]/gu, "'");
}

export function resolveAnchor(text, anchor) {
  const exactCount = countOccurrences(text, anchor);
  if (exactCount === 1) return { anchor, count: 1, normalized: false };
  if (exactCount > 1) return { anchor, count: exactCount, normalized: false };

  const normalizedText = normalizeAnchorTypography(text);
  const normalizedAnchor = normalizeAnchorTypography(anchor);
  const normalizedCount = countOccurrences(normalizedText, normalizedAnchor);
  if (normalizedCount !== 1) return { anchor, count: normalizedCount, normalized: true };

  const index = normalizedText.indexOf(normalizedAnchor);
  return {
    // 上面的字符映射均为单个 Unicode 码元，可安全映射回原始正文。
    anchor: text.slice(index, index + anchor.length),
    count: 1,
    normalized: true,
  };
}
