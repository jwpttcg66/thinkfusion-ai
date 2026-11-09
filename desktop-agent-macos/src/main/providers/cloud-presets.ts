/**
 * 云端服务的预设。
 *
 * 为什么是「预设 + 可编辑」而不是一份写死的模型表：云厂商改模型名比改
 * 文档还快。2026-07-24 DeepSeek 停用了 `deepseek-chat` / `deepseek-reasoner`，
 * 任何把旧名字写死的客户端都会在当天开始报 404。预设给的是「今天能用」的
 * 起点，模型列表在界面上可改，改完立刻生效。
 *
 * 只收录**走 Chat Completions** 的服务。OpenCode 这里收的是订阅制的 **Go**
 * 网关（`/inference/go`）：它会把所有文本模型翻译成 Chat Completions，所以
 * GPT / Claude / Gemini 也能用。按量计费的 Zen（`/inference`）不再单列——
 * 它的 GPT 系列走 `/responses`、Claude 系列走 `/messages`，本 Provider 调不了；
 * 真要按量付费，把端点改成 `https://opencode.ai/inference/openai/v1` 即可。
 */

export interface CloudPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** 给界面看的一句话：这个服务有哪些模型不能用、为什么。 */
  note?: string;
}

/**
 * OpenCode Go 网关 2026-11-09 报的 chat 模型。
 *
 * 为什么不只列六条「主力」：只列六条时，界面在还没配 Key / 还没读到网关的
 * 这段时间里会说「这家只有六个模型」。清单本来就是网关给的公开信息，本地
 * 留一份完整副本，用户第一次打开就能看到全部并勾选。
 *
 * 清单本体放在 shared（浏览器预览的 mock 也要用同一份）；这里转出去，调用方
 * 不必知道它搬过家。
 */
import { OPENCODE_GO_MODELS } from '../../shared/opencode-models';
export { OPENCODE_GO_MODELS };

export const CLOUD_PRESETS: readonly CloudPreset[] = [  {
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
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    models: [...OPENCODE_GO_MODELS],
    note: '订阅制：额度按模型月度上限算（服务端拦），本界面不估算单价；模型清单来自网关 /models，可自改'
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

/**
 * 「添加云模型」里可选的服务目录。
 *
 * 和 `CLOUD_PRESETS` 的区别是「默认装」与「可选装」：上面那三条一装就有，
 * 这份是一张可以被挑的清单——用户从里面选一家、贴上 Key，就多出一组云端
 * 成员。目录里的端点**只收 OpenAI 兼容（Chat Completions）**的：本 Provider
 * 不会说 Anthropic / Gemini 的原生协议，收进来只会让人填完 Key 才看到报错。
 * 要调那两家的模型，选 OpenRouter 这类聚合网关。
 *
 * 默认模型只是「填进去就能试」的起点，官方改名比改文档快，所以界面上
 * 允许一键从 `/models` 拉真实清单，也允许直接改写。
 */
export interface ProviderCatalogEntry {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  note?: string;
  /** 自定义项：端点必须自己填。 */
  custom?: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    models: [...OPENCODE_GO_MODELS],
    note: '订阅制，额度按模型月度上限在服务端拦；网关会把非 chat 模型翻译成 chat/completions'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4o-mini'],
    note: '聚合网关：Anthropic / Gemini / xAI 都从这一条走，不必单独接原生协议'
  },
  { id: 'moonshot', label: 'Moonshot（Kimi）', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo'] },
  {
    id: 'dashscope',
    label: '阿里百炼（通义）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus']
  },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus'] },
  { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3'] },
  { id: 'ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k'] },
  { id: 'hunyuan', label: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', models: ['hunyuan-turbo'] },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1', models: ['grok-2-latest'] },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile'] },
  { id: 'together', label: 'Together', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'] },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    models: [],
    note: '自建网关、公司内网或上面没列的服务：填以 /v1 结尾的端点，再填一个模型名',
    custom: true
  }
];

export function catalogEntryOf(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find(entry => entry.id === id);
}

/**
 * 用户加的服务 id。
 *
 * 用 `user:` 前缀，而不是沿用目录 id：目录里已有 `openai`，如果允许改它的
 * 端点，「恢复默认」就再也找不到原值；两类分开存，删除也只删得掉自己加的。
 */
export function userProviderId(label: string, taken: Iterable<string>): string {
  // 保留各语言的字母与数字：中文名如果被整段删掉，id 会退化成 `user:custom`，
  // 列表里两家中转网关就再也分不出谁是谁。id 只做内部键，不需要是 URL 片段。
  const slug = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const used = new Set(taken);
  const base = `user:${slug || 'custom'}`;
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const next = `${base}-${index}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${Date.now()}`;
}

export function isUserProvider(id: string): boolean {
  return id.startsWith('user:');
}
