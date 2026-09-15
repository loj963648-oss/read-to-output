import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const projectRoot = process.cwd();
const staging = path.join(projectRoot, ".rto-pack-staging");
const payload = path.join(staging, "payload");
const archivePath = path.join(projectRoot, "read-to-output-pi.zip");

const items = [
  ".pi",
  "src",
  "scripts",
  "docs",
  "start-read-to-output.cmd",
  "start-read-to-output.command",
  "start-read-to-output-test.cmd",
  "rto.cmd",
  "rto-test.cmd",
  "rto-test-reset.cmd",
  "package.json",
  "README.md",
  "release",
];

const templateConfig = {
  version: 1,
  mode: "phase-5-real-storage",
  writeMode: "real",
  vaultRoot: "C:/path/to/your/Obsidian Vault",
  progressFile: "学习进度.md",
  runtime: { thinkingLevel: "off", lockModelTools: true },
  books: [],
};
const templateState = {
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

await rm(staging, { recursive: true, force: true });
try {
  await mkdir(path.join(payload, ".read-to-output", "prompts"), { recursive: true });
  await mkdir(path.join(payload, ".read-to-output", "backups"), { recursive: true });

  for (const item of items) {
    await cp(path.join(projectRoot, item), path.join(payload, item), { recursive: true });
  }

  await writeFile(
    path.join(payload, ".read-to-output", "config.json"),
    `${JSON.stringify(templateConfig, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(payload, ".read-to-output", "state.json"),
    `${JSON.stringify(templateState, null, 2)}\n`,
    "utf8",
  );
  await cp(
    path.join(projectRoot, ".read-to-output", "prompts"),
    path.join(payload, ".read-to-output", "prompts"),
    { recursive: true },
  );

  await rm(archivePath, { force: true });
  execFileSync("tar.exe", ["-a", "-c", "-f", archivePath, "."], {
    cwd: payload,
    stdio: "inherit",
  });
  console.log("read-to-output-pi.zip 已重新打包（含空模板配置，不含个人数据）");
} finally {
  await rm(staging, { recursive: true, force: true });
}
