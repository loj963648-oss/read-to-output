import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboard, extractCurrentSegment, loadRuntime } from "../src/state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await loadRuntime(projectRoot);
const dashboard = buildDashboard(runtime);
const economics = await extractCurrentSegment(runtime, "economics");

console.log(JSON.stringify({
  mode: runtime.config.mode,
  books: dashboard.books.map((book) => ({ id: book.id, summary: book.summary })),
  lastBookId: dashboard.lastBookId,
  freshness: dashboard.freshness,
  startupRead: dashboard.metrics,
  verifiedSegment: {
    id: economics.segmentId,
    words: economics.words,
    characters: economics.characters,
    startOccurrences: economics.startOccurrences,
    endOccurrences: economics.endOccurrences,
  },
}, null, 2));
