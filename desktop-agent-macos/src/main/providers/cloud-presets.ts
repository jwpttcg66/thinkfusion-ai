/**
 * 云端服务的预设。
 *
 * 为什么是「预设 + 可编辑」而不是一份写死的模型表：云厂商改模型名比改
 * 文档还快。2026-07-24 DeepSeek 停用了 `deepseek-chat` / `deepseek-reasoner`，
 * 任何把旧名字写死的客户端都会在当天开始报 404。预设给的是「今天能用」的
 * 起点，模型列表在界面上可改，改完立刻生效。
 *
 * 只收录**走 Chat Completions** 的服务。OpenCode Zen 的 GPT 系列走
 * `/responses`、Claude 系列走 `/messages`，和这里的 Provider 不是一套协议，
 * 写进来只会在第一次调用时失败，所以不列，并在 note 里说清楚。
 */

export interface CloudPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** 给界面看的一句话：这个服务有哪些模型不能用、为什么。 */
  note?: string;
}

export const CLOUD_PRESETS: readonly CloudPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    note: 'deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用；旧账号若仍只认旧名，在这里改回即可'
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'glm-5.2', 'kimi-k2.6', 'minimax-m2.7'],
    note: '只列走 Chat Completions 的模型；GPT 系列走 Responses、Claude 走 Messages，本 Provider 调不了'
  }
];

export function presetOf(id: string): CloudPreset | undefined {
  return CLOUD_PRESETS.find(preset => preset.id === id);
}

/**
 * 模型清单收敛：去空白、去重、丢掉非字符串。空数组视为「没填」，
 * 交回预设，而不是让一个服务变成零模型。
 */
export function normalizeModels(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export interface CloudOverride {
  baseUrl?: string;
  models?: string[];
}

/** 预设 + 用户覆盖。baseUrl 只接受 http(s)，避免写进一个奇怪的 scheme。 */
export function resolvePreset(preset: CloudPreset, override?: CloudOverride | null): CloudPreset {
  const baseUrl = typeof override?.baseUrl === 'string' && /^https?:\/\//.test(override.baseUrl.trim())
    ? override.baseUrl.trim().replace(/\/+$/, '')
    : preset.baseUrl;
  const models = normalizeModels(override?.models);
  return {
    ...preset,
    baseUrl,
    models: models.length > 0 ? models : [...preset.models]
  };
}
