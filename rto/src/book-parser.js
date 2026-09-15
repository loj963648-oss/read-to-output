import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * 最小 ZIP 解析器：只读取文件条目（store / deflate）。
 * 用于解析 EPUB（本质是 zip 容器），避免引入第三方依赖。
 */
export function parseZip(buffer) {
  const eocd = findEocd(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CD_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer.toString("utf8", cursor + 46, cursor + 46 + fileNameLength);
    entries.set(fileName, { method, compressedSize, localOffset });
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return {
    list() {
      return [...entries.keys()];
    },
    read(name) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`ZIP 内不存在文件：${name}`);
      const local = entry.localOffset;
      if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
        throw new Error(`ZIP 本地头损坏：${name}`);
      }
      const nameLength = buffer.readUInt16LE(local + 26);
      const extraLength = buffer.readUInt16LE(local + 28);
      const dataStart = local + 30 + nameLength + extraLength;
      const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
      return entry.method === 0 ? data : inflateRawSync(data);
    },
  };
}

function findEocd(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  for (let cursor = buffer.length - 22; cursor >= minOffset; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor;
  }
  throw new Error("不是有效的 ZIP 文件（找不到结束记录）");
}

/** 从 HTML 片段中提取可见文本，保留段落结构。 */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|blockquote|section)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/\r?\n[ \t]+/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeText(data, fallback = "utf8") {
  const bytes = Buffer.from(data);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  return bytes.toString(fallback);
}

/**
 * 解析 EPUB：返回 { title, chapters: [{ title, text }] }。
 * chapters 按 spine 顺序排列，只包含 xhtml 章节内容。
 */
export function parseEpub(buffer) {
  const zip = parseZip(buffer);
  const containerXml = decodeText(zip.read("META-INF/container.xml"));
  const opfPath = containerXml.match(/full-path="([^"]+)"/u)?.[1];
  if (!opfPath) throw new Error("EPUB 缺少 container.xml 中的 OPF 路径");

  const opf = decodeText(zip.read(opfPath));
  const manifest = new Map();
  for (const match of opf.matchAll(/<item\b[^>]*>/giu)) {
    const id = match[0].match(/\bid="([^"]+)"/iu)?.[1];
    const href = match[0].match(/\bhref="([^"]+)"/iu)?.[1];
    const media = match[0].match(/\bmedia-type="([^"]+)"/iu)?.[1];
    if (id && href) manifest.set(id, { href, media: media ?? "" });
  }
  const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/iu)?.[1]?.replace(/<[^>]+>/gu, "").trim()
    ?? "未命名书籍";

  const spine = [];
  for (const match of opf.matchAll(/<itemref\b[^>]*>/giu)) {
    const idref = match[0].match(/\bidref="([^"]+)"/iu)?.[1];
    if (idref && manifest.has(idref)) spine.push(manifest.get(idref));
  }
  if (!spine.length) throw new Error("EPUB 的 spine 为空，无法确定章节顺序");

  const basePath = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const chapters = [];
  for (const item of spine) {
    if (!/xhtml|html/iu.test(item.media)) continue;
    const fullPath = `${basePath}${item.href}`;
    const raw = zip.read(fullPath);
    const text = htmlToText(decodeText(raw));
    const headingMatch = text.match(/^\s*(?:第\s*[一二三四五六七八九十百千万\d]+\s*[章卷部节]|[A-Za-z]+\s*\d+|Chapter\s+\d+|PART\s+\w+)[^\n]*/iu);
    const chapterTitle = headingMatch?.[0].trim()
      || item.href.split("/").at(-1).replace(/\.(xhtml|html)$/iu, "").replace(/[-_]/gu, " ")
      || `章节 ${chapters.length + 1}`;
    if (text.trim()) chapters.push({ title: chapterTitle, text });
  }
  if (!chapters.length) throw new Error("EPUB 中没有可解析的章节内容");
  return { title, chapters };
}

const TXT_CHAPTER_PATTERN = /^(?:第\s*[一二三四五六七八九十百千万\d]+\s*[章卷部节]|Chapter\s+\d+|CHAPTER\s+\d+|\d+\.\s+[A-Z])[^\n]*$/gimu;

/**
 * 解析 TXT：按 “第N章 / Chapter N / N. 标题” 拆章。
 */
export function parseTxt(text, fallbackName = "未命名书籍") {
  const clean = text.replace(/^\uFEFF/u, "");
  const markers = [];
  for (const match of clean.matchAll(TXT_CHAPTER_PATTERN)) {
    markers.push({ index: match.index, title: match[0].trim() });
  }
  if (markers.length <= 1) {
    return { title: fallbackName, chapters: [{ title: fallbackName, text: clean.trim() }] };
  }
  const chapters = [];
  for (let index = 0; index < markers.length; index += 1) {
    const start = markers[index].index;
    const end = index + 1 < markers.length ? markers[index + 1].index : clean.length;
    const body = clean.slice(start + markers[index].title.length, end).trim();
    if (body) chapters.push({ title: markers[index].title, text: body });
  }
  return { title: fallbackName, chapters };
}
