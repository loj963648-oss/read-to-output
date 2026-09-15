import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./sandbox.js";
import { getRuntimeDirectoryName } from "./state.js";

function configPath(projectRoot) {
  return path.join(projectRoot, getRuntimeDirectoryName(), "config.json");
}

function statePath(projectRoot) {
  return path.join(projectRoot, getRuntimeDirectoryName(), "state.json");
}

/**
 * 检测是否首次启动：config.json 缺失，或 config.books 为空。
 * 已有图书时不走引导（state 缺失等情况交给 loadRuntime 报错）。
 */
export async function isFirstRun(projectRoot) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath(projectRoot), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  if (!Array.isArray(config.books) || config.books.length === 0) return true;
  return false;
}

function initialConfig(vaultRoot) {
  return {
    version: 1,
    mode: "phase-5-real-storage",
    writeMode: "real",
    vaultRoot,
    progressFile: "学习进度.md",
    runtime: {
      thinkingLevel: "off",
      lockModelTools: true,
    },
    books: [],
  };
}

function initialState() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceSnapshot: null,
    lastBookId: null,
    cadence: {
      normalReadingCount: 0,
      nextSession: "ordinary",
      newBacktranslationWords: "25–40",
      backtranslationMode: "light",
    },
    books: {},
  };
}

function initialProgress() {
  return [
    "# 学习进度",
    "",
    "> 本文件由 Read-to-Output 自动维护，请勿手动修改分段计划区块。",
    "",
    "## 当前进度",
    "",
    "- 尚无图书，请先通过 `/learn add-book` 导入第一本书。",
    "",
    "## 英语输出节奏",
    "",
    "- 普通阅读场计数：0",
    "- 下次场次：普通阅读场",
    "- 新回译参考量：25–40 词",
    "",
    "## 复习队列",
    "",
    "- 暂无",
    "",
    "## 回译复习队列",
    "",
    "- 暂无",
    "",
    "## 表达力追踪",
    "",
    "| 日期 | 章节 | 阅读词数 | 阅读时长(分) | 速度(词/分) | 结构评级(1-5) | 主要问题 | 追问次数 |",
    "|------|------|----------|-------------|------------|-------------|---------|---------|",
    "",
  ].join("\n");
}

/**
 * 创建初始 config.json / state.json / 学习进度.md。
 * vaultRoot 必须存在（引导流程会先让用户确认路径）。
 */
export async function bootstrapRuntime(projectRoot, vaultRoot) {
  const runtimeRoot = path.join(projectRoot, getRuntimeDirectoryName());
  await mkdir(runtimeRoot, { recursive: true });
  const resolvedVault = path.resolve(vaultRoot);
  try {
    const vaultStat = await stat(resolvedVault);
    if (!vaultStat.isDirectory()) throw new Error("Obsidian 库路径不是文件夹");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Obsidian 库路径不存在：${resolvedVault}`);
    throw error;
  }
  const config = initialConfig(resolvedVault);
  const state = initialState();
  const progressFile = path.join(resolvedVault, config.progressFile);
  let progressExists = false;
  try {
    await access(progressFile);
    progressExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (!progressExists) {
    await atomicWrite(progressFile, initialProgress());
  }
  // 刷新学习进度快照，保证后续操作 freshness=current
  const progressStat = await stat(progressFile);
  state.sourceSnapshot = {
    size: progressStat.size,
    lastWriteTimeUtc: progressStat.mtime.toISOString(),
  };
  await writeFile(statePath(projectRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // 创建常用笔记目录
  await mkdir(path.join(resolvedVault, "费曼笔记"), { recursive: true });
  await mkdir(path.join(resolvedVault, "回译"), { recursive: true });
  return {
    vaultRoot: resolvedVault,
    progressCreated: !progressExists,
  };
}
