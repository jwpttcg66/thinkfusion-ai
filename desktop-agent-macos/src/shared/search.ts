/**
 * 联网搜索的共享定义（不依赖 node，renderer 与 agent 都能引）。
 *
 * 为什么需要一份「提供方清单」而不是写死一个接口：搜索不是本机能力，
 * 它一定要落到某个外部服务上，而外部服务全都要凭据。把提供方做成可选清单，
 * 好处是三件事同时成立——用户配了哪家就用哪家、换家不用改代码、
 * 没配时能诚实地告诉用户「搜不了」，而不是返回一段看起来像结果的编造内容。
 *
 * 免凭据路径有几条，按可靠性排：应用内浏览器打开 Bing 结果页（需要主进程，
 * 受限网络下唯一稳定的一条）、Bing RSS、DuckDuckGo Instant Answer + Wikipedia
 * 摘要。后两条都只给「摘要级」信息，且都要在 `degraded` 里说明。
 */

/** 需要凭据或实例地址的提供方。 */
export const SEARCH_PROVIDERS = ['brave', 'tavily', 'serper', 'searxng'] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

/** 免 key 兜底，不走 `SEARCH_PROVIDERS`，因为它不需要配置。 */
export const FALLBACK_PROVIDER = 'ddg';

export const SEARCH_PROVIDER_LABEL: Record<string, string> = {
  brave: 'Brave Search',
  tavily: 'Tavily',
  serper: 'Serper（Google 结果）',
  searxng: 'SearXNG（自建实例）',
  bing: 'Bing RSS（免凭据）',
  browser: '应用内浏览器（Bing 结果页，免凭据）',
  ddg: 'DuckDuckGo 摘要（免凭据，只有摘要）'
};

/** 每个提供方要填什么。设置界面据此决定显示哪个输入框。 */
export const SEARCH_PROVIDER_FIELD: Record<SearchProvider, 'apiKey' | 'searxngUrl'> = {
  brave: 'apiKey',
  tavily: 'apiKey',
  serper: 'apiKey',
  searxng: 'searxngUrl'
};

export interface SearchSettings {
  /** 用户显式选择的提供方。留空时按「有凭据的那个」自动挑。 */
  provider?: SearchProvider;
  apiKey?: string;
  searxngUrl?: string;
}

export const DEFAULT_SEARCH_RESULTS = 8;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_SEARCH_QUERY = 300;

/**
 * 设置界面看到的东西。
 *
 * key 原文不出主进程：界面只需要知道「填了没有」「末四位是哪一把」。
 * 一份能被渲染进程读回来的密钥，等于把它写进了任何一个 devtools 截图。
 */
export interface SearchSettingsView {
  provider?: SearchProvider;
  hasKey: boolean;
  /** 末四位，用来确认「填的是不是我以为的那把」。 */
  keyHint?: string;
  searxngUrl?: string;
  /** 环境变量里配的那套在生效，此时界面上的文件配置不生效。 */
  fromEnv: boolean;
  configPath: string;
  /** 没配任何凭据，只剩免 key 摘要可走。 */
  fallbackOnly: boolean;
}

export interface SearchSettingsPatch {
  /** `null` 表示「清掉，回到免凭据摘要」。 */
  provider?: SearchProvider | null;
  apiKey?: string;
  searxngUrl?: string;
}

export interface SearchTestResult {
  ok: boolean;
  provider?: string;
  note: string;
  sample?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** 1 起，越小越靠前。同一个 url 只保留最靠前的那次。 */
  rank: number;
}

export interface WebSearchResult {
  query: string;
  /** 实际给出结果的提供方；`ddg` 表示走的是免凭据兜底。 */
  provider: string;
  results: SearchHit[];
  /** 提供方直接给出的答案摘要（Brave/Tavily 的 summary、DDG 的 Abstract）。 */
  answer?: string;
  /** 结果不完整或降级时，这里必须有一句人话说明原因。 */
  degraded?: string;
  tookMs: number;
  /** 每个尝试过的提供方与结果，用于解释「为什么是它答的」。 */
  attempts: Array<{ provider: string; ok: boolean; note?: string }>;
}

/**
 * 当前唯一可用的提供方，没有就是 null。
 *
 * 一次只认一个：一个 key 只对一家有效，同时存多个 key 会让「这条凭据属于谁」
 * 变成一个要猜的问题，猜错的症状是「凭据无效」——而真正的问题是配错了家。
 * 要换提供方就重新填一次，这条路径不需要猜。
 */
export function configuredProvider(settings: SearchSettings): SearchProvider | null {
  if (!settings.provider) return null;
  const field = SEARCH_PROVIDER_FIELD[settings.provider];
  const value = field === 'searxngUrl' ? settings.searxngUrl : settings.apiKey;
  return value?.trim() ? settings.provider : null;
}
