import { createHash } from "node:crypto";
import path from "node:path";

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function bookStorageDirectoryName(bookId) {
  const raw = String(bookId ?? "").trim();
  if (!raw) throw new Error("缺少图书 ID，无法确定笔记目录");
  const directlyUsable = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(raw)
    && raw !== "."
    && raw !== ".."
    && !WINDOWS_RESERVED_NAMES.test(raw);
  if (directlyUsable) return raw;

  const cleaned = raw
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  const base = cleaned && !WINDOWS_RESERVED_NAMES.test(cleaned) ? cleaned : "book";
  return `${base}-${hash}`;
}

export function bookNotesRoot(runtime, bookId) {
  return path.join(
    runtime.config.vaultRoot,
    "费曼笔记",
    bookStorageDirectoryName(bookId),
  );
}
