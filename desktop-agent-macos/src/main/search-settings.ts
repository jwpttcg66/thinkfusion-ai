/**
 * 联网搜索设置的读写（主进程侧）。
 *
 * 为什么密钥不放在渲染进程：设置面板只需要知道「填了没有」，不需要拿到原文。
 * 一份能被 devtools 读到的 key 等于已经泄露——截图、粘贴日志、随手一个
 * `console.log` 都会把它带出去。所以 `SearchSettingsView` 只回 `hasKey` 和末四位。
 *
 * 文件格式故意保持「人可以直接编辑」：出了问题能打开看一眼，
 * 不用去猜某个二进制设置库。环境变量优先于文件，见 `readSearchSettings`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_FIELD,
  type SearchProvider,
  type SearchSettings,
  type SearchSettingsPatch,
  type SearchSettingsView,
  type SearchTestResult
} from '../shared/search';
import { SEARCH_CONFIG_PATH, readSearchSettings, testSearch } from '../agent/tools/web-search';

export { SEARCH_CONFIG_PATH };

export async function viewSearchSettings(): Promise<SearchSettingsView> {
  const settings = await readSearchSettings();
  const envProvider = envConfiguredProvider();
  const provider = settings.provider;
  const hasKey = provider === 'searxng' ? !!settings.searxngUrl?.trim() : !!settings.apiKey?.trim();
  return {
    provider,
    hasKey,
    keyHint: settings.apiKey ? `…${settings.apiKey.slice(-4)}` : undefined,
    searxngUrl: settings.searxngUrl,
    fromEnv: !!envProvider,
    configPath: SEARCH_CONFIG_PATH,
    fallbackOnly: !provider || !hasKey
  };
}

export async function saveSearchSettings(patch: SearchSettingsPatch): Promise<SearchSettingsView> {
  const current = await readFileSettings();
  const next: SearchSettings = { ...current };

  if (patch.provider !== undefined) {
    if (patch.provider === null) {
      next.provider = undefined;
      next.apiKey = undefined;
      next.searxngUrl = undefined;
    } else {
      if (!SEARCH_PROVIDERS.includes(patch.provider)) throw new Error('未知的搜索提供方');
      // 换提供方就丢掉旧凭据：一个 key 只对一家有效，留着它只会让下一个人
      // 拿着 A 家的 key 去问 B 家，然后收到一句「凭据无效」。
      if (next.provider && next.provider !== patch.provider) {
        next.apiKey = undefined;
        next.searxngUrl = undefined;
      }
      next.provider = patch.provider;
    }
  }
  if (patch.apiKey !== undefined) next.apiKey = patch.apiKey.trim() || undefined;
  if (patch.searxngUrl !== undefined) next.searxngUrl = patch.searxngUrl.trim() || undefined;

  if (next.provider) {
    const field = SEARCH_PROVIDER_FIELD[next.provider as SearchProvider];
    const value = field === 'searxngUrl' ? next.searxngUrl : next.apiKey;
    if (!value) {
      throw new Error(
        field === 'searxngUrl'
          ? '选了 SearXNG 就要填实例地址，例如 https://searx.example.com'
          : '选了提供方就要填 API key'
      );
    }
  }

  await fs.mkdir(path.dirname(SEARCH_CONFIG_PATH), { recursive: true, mode: 0o700 });
  // 同目录临时文件 + rename：写到一半断电不会留下半个 JSON，
  // 也就不会出现「设置打不开、搜索也读不到」这种两头堵的状态。
  const temp = path.join(path.dirname(SEARCH_CONFIG_PATH), `.search-config.${process.pid}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, SEARCH_CONFIG_PATH);

  return viewSearchSettings();
}

export async function runSearchTest(patch: SearchSettingsPatch): Promise<SearchTestResult> {
  const merged: SearchSettings = { ...(await readFileSettings()) };
  if (patch.provider !== undefined) merged.provider = patch.provider ?? undefined;
  if (patch.apiKey !== undefined) merged.apiKey = patch.apiKey.trim() || undefined;
  if (patch.searxngUrl !== undefined) merged.searxngUrl = patch.searxngUrl.trim() || undefined;
  return testSearch(merged);
}

async function readFileSettings(): Promise<SearchSettings> {
  try {
    const raw = await fs.readFile(SEARCH_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SearchSettings;
    return {
      provider: parsed.provider,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
      searxngUrl: typeof parsed.searxngUrl === 'string' ? parsed.searxngUrl : undefined
    };
  } catch {
    return {};
  }
}

function envConfiguredProvider(): string | null {
  if (process.env.BRAVE_API_KEY?.trim()) return 'brave';
  if (process.env.TAVILY_API_KEY?.trim()) return 'tavily';
  if (process.env.SERPER_API_KEY?.trim()) return 'serper';
  if (process.env.SEARXNG_URL?.trim()) return 'searxng';
  return null;
}

/** 给设置界面显示的默认建议：文件到底在哪，方便用户自己去看。 */
export function searchConfigDir(): string {
  return path.dirname(SEARCH_CONFIG_PATH);
}
