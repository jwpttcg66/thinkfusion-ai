/**
 * What kind of thing the user just asked for.
 *
 * This exists because the previous build had exactly one answer to that
 * question — "a workspace task" — so a question about Redis connection counts
 * was forced down a path that ends in file operations, and the model dutifully
 * invented steps to satisfy it.
 *
 * Classification is deliberately rule-first and boring. A model call here would
 * add a round trip to every message, and would fail in a way that is hard to
 * explain to a user ("why did it decide my question was about files?"). Rules
 * can be read, tested, and pointed at.
 */

export type IntentKind = 'answer' | 'research' | 'compare' | 'extract' | 'workspace';

export interface Intent {
  kind: IntentKind;
  /** Why this classification won — shown in the UI so routing is auditable. */
  reason: string;
  /** Set for `extract`: the URL the user pointed at. */
  url?: string;
}

/**
 * Verbs that mean "change something on disk".
 *
 * These only count together with a file hint. "帮我分析这段代码" has a noun that
 * looks file-ish but no verb, and must stay a question; "帮我改这个文件" has
 * both, and must not become a research task.
 */
const WORKSPACE_VERBS = /(修改|改成|改一下|改这个|编辑|写入|写到|创建|新建|删除|删掉|重命名|移动到|跑一下|执行一下|运行一下|保存到|生成.{0,6}文件)/;

const FILE_HINTS = /(文件|目录|文件夹|仓库|工程|代码|路径|工作区|\.(ts|tsx|js|jsx|mjs|json|md|py|sh|yml|yaml|css|html)\b)/;

const EXTRACT_HINTS = /(整理|总结|摘要|提取|概括|看看这个|这个网页|这篇文章|这个链接)/;

const COMPARE_HINTS = /(比较|对比|相比|区别|差异|哪个更好|哪个更适合|选型|\bvs\b|\bVS\b)/;

const RESEARCH_HINTS = /(研究|调研|分析|排查|原因|方案|为什么|为何|怎么|如何|影响|原理|机制|最佳实践|坑|优化)/;

/** A bare http(s) URL, used to decide `extract` vs `research`. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'）)]+/i;

export function classifyIntent(text: string): Intent {
  const input = text.trim();
  const url = URL_PATTERN.exec(input)?.[0];

  // 1. Explicit intent to change local state. Checked first: if someone says
  //    "改一下这个文件并分析一下", the execution part must not be lost.
  if (WORKSPACE_VERBS.test(input) && FILE_HINTS.test(input)) {
    return { kind: 'workspace', reason: '出现了改动动词 + 文件线索' };
  }

  // 2. A URL plus a request to digest it. A URL on its own is a research
  //    question about that page, not an instruction to scrape it.
  if (url && EXTRACT_HINTS.test(input)) {
    return { kind: 'extract', reason: '带链接 + 整理/总结类动词', url };
  }

  // 3. Comparison is a distinct output shape: it needs the same question asked
  //    of several channels, then a side-by-side answer.
  if (COMPARE_HINTS.test(input)) {
    return { kind: 'compare', reason: '出现比较类词' };
  }

  if (RESEARCH_HINTS.test(input)) {
    return { kind: 'research', reason: '出现研究/分析类词' };
  }

  return { kind: 'answer', reason: '默认按问答处理' };
}

/** Intents that fan out across channels and end in a synthesis. */
export function isMultiChannel(kind: IntentKind): boolean {
  return kind === 'research' || kind === 'compare' || kind === 'extract';
}
