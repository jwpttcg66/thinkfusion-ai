/**
 * P3-02：Agentic Search 的“下一步查什么”决策层。
 * 只出动作计划，不启动全仓扫描；执行由现有工具完成。
 */
export type SearchTool = 'search' | 'find' | 'tree' | 'read' | 'symbol' | 'git';

export interface SearchAction {
  tool: SearchTool;
  query: string;
  reason: string;
}

export interface SearchScope {
  paths?: string[];
}

export function planSearch(question: string, scope: SearchScope = {}): SearchAction[] {
  const text = question.trim();
  const actions: SearchAction[] = [];
  const path = text.match(/[\w./-]+\.(?:ts|tsx|js|mjs|java|json|md)/)?.[0];
  if (path) actions.push({ tool: 'read', query: path, reason: '问题点名了文件' });
  if (/(定义|声明|在哪|symbol|函数|类)/i.test(text)) {
    actions.push({ tool: 'symbol', query: text, reason: '需要符号定位' });
  }
  if (/(调用|引用|用到|影响|impact)/i.test(text)) {
    actions.push({ tool: 'search', query: text, reason: '需要调用/引用检索' });
  }
  if (/(目录|结构|tree|模块)/i.test(text)) {
    actions.push({ tool: 'tree', query: scope.paths?.[0] ?? '.', reason: '需要看目录结构' });
  }
  if (/(改了什么|diff|提交|commit|git)/i.test(text)) {
    actions.push({ tool: 'git', query: 'diff', reason: '需要看变更' });
  }
  if (actions.length === 0) actions.push({ tool: 'search', query: text, reason: '默认关键词检索' });
  return actions.slice(0, 5);
}
