import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, ".read-to-output-sandbox");
const fixtures = path.join(runtimeRoot, "fixtures");
const sandboxVault = path.join(projectRoot, "sandbox-vault");
const expectedVault = path.resolve(projectRoot, "sandbox-vault");

if (path.resolve(sandboxVault) !== expectedVault || path.dirname(expectedVault) !== projectRoot) {
  throw new Error("拒绝重置：沙盒路径校验失败");
}

await rm(sandboxVault, { recursive: true, force: true });
await rm(path.join(runtimeRoot, "active-session.json"), { force: true });
await rm(path.join(runtimeRoot, "active-output-session.json"), { force: true });
await rm(path.join(runtimeRoot, "backtranslation-queue.json"), { force: true });
await rm(path.join(runtimeRoot, "knowledge-queue.json"), { force: true });
await rm(path.join(runtimeRoot, "spelling-history.json"), { force: true });
await rm(path.join(runtimeRoot, "last-verified-session.json"), { force: true });
await rm(path.join(runtimeRoot, "spelling-book.md"), { force: true });
await mkdir(path.join(sandboxVault, "Test Book", "Chapters"), { recursive: true });
await mkdir(path.join(sandboxVault, "费曼笔记"), { recursive: true });
await Promise.all([
  copyFile(path.join(fixtures, "state.json"), path.join(runtimeRoot, "state.json")),
  copyFile(path.join(fixtures, "学习进度.md"), path.join(sandboxVault, "学习进度.md")),
  copyFile(
    path.join(fixtures, "Ch01-A-Tiny-Test-Chapter.md"),
    path.join(sandboxVault, "Test Book", "Chapters", "Ch01-A-Tiny-Test-Chapter.md"),
  ),
]);

console.log("Read-to-Output 沙盒已重置。真实 Obsidian 未被读取或修改。");
