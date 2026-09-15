import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 支持的 provider 及对应 auth.json key。
 * auth.json 格式与 pi 官方一致：{ "<key>": { "type": "api_key", "key": "sk-..." } }
 */
export const API_PROVIDERS = [
  { id: "deepseek", label: "DeepSeek（推荐，便宜）", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com" },
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic / Claude", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/settings/keys" },
];

export function authFilePath() {
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(piAgentDir, "auth.json");
}

/**
 * 读取 auth.json（不存在返回空对象）。
 */
export async function readAuthFile() {
  try {
    return JSON.parse(await readFile(authFilePath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * 检测指定 provider 是否已有可用 key（auth.json 或环境变量）。
 */
export async function hasProviderKey(providerId) {
  const provider = API_PROVIDERS.find((item) => item.id === providerId);
  if (!provider) return false;
  if (process.env[provider.env]) return true;
  const auth = await readAuthFile();
  const entry = auth[providerId];
  return Boolean(entry && (entry.type === "api_key" || entry.apiKey) && (entry.key || entry.apiKey));
}

/**
 * 检测当前模型是否可用（context 注入的模型 + provider 解析）。
 */
export async function isModelAvailable(ctx) {
  if (!ctx.model?.provider) return false;
  try {
    const auth = typeof ctx.modelRegistry?.getProviderAuth === "function"
      ? await ctx.modelRegistry.getProviderAuth(ctx.model.provider)
      : null;
    if (auth && (auth.apiKey || auth.key || auth.headers)) return true;
  } catch {
    // 解析失败按不可用处理
  }
  return hasProviderKey(ctx.model.provider);
}

/**
 * 把 API key 写入 auth.json（保留已有条目）。
 */
export async function storeApiKey(providerId, apiKey) {
  const key = apiKey.trim();
  if (!key) throw new Error("API key 不能为空");
  const auth = await readAuthFile();
  const next = {
    ...auth,
    [providerId]: { type: "api_key", key },
  };
  await mkdir(path.dirname(authFilePath()), { recursive: true });
  await writeFile(authFilePath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
