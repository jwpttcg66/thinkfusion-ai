/**
 * 单文件 unified diff 的解析与应用。
 *
 * 抽成纯函数，是因为它现在有两个调用方：
 * - `fs.applyPatch` 真正落盘；
 * - 多 Agent 编码在**应用之前**做 dry-run（路径、hunk 上下文、版本）。
 *
 * 两边必须用同一套规则。以前 dry-run 只能靠字面量猜，或者干脆不做——
 * 那等于把「补丁能不能应用」留到写盘那一刻才暴露。
 */

export interface UnifiedHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  body: string[];
}

export interface ParseDiffOptions {
  /** 补丁文本上限，默认 512 KB。 */
  maxBytes?: number;
  /** hunk 数量上限，默认 64。 */
  maxHunks?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_HUNKS = 64;

/** 解析单文件 unified diff。文件头（--- / +++）只作形状校验，路径不参与定位。 */
export function parseUnifiedDiff(patch: string, options: ParseDiffOptions = {}): UnifiedHunk[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxHunks = options.maxHunks ?? DEFAULT_MAX_HUNKS;
  if (new TextEncoder().encode(patch).length > maxBytes) throw new Error('补丁过大');
  // 末尾换行是补丁文本自身的结束符，不是一条没有前缀的空行。
  const lines = patch.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const hunks: UnifiedHunk[] = [];
  let current: UnifiedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        body: []
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      if (line.trim() === '') continue;
      throw new Error('补丁缺少 @@ hunk 头，或存在无法识别的行');
    }
    if (line === '\\ No newline at end of file') continue;
    if (!/^[ +\-]/.test(line)) throw new Error('补丁里有既不是上下文也不是增删的行');
    current.body.push(line);
  }

  if (hunks.length === 0) throw new Error('补丁里没有任何 hunk');
  if (hunks.length > maxHunks) throw new Error(`hunk 数量超过上限 ${maxHunks}`);
  return hunks;
}

export function applyUnifiedHunks(content: string, hunks: UnifiedHunk[]): string {
  const trailingNewline = content.endsWith('\n');
  const crlf = content.includes('\r\n');
  const original = content.replace(/\r\n/g, '\n').split('\n');
  if (trailingNewline) original.pop();

  const out: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    if (start < cursor || start > original.length) {
      throw new Error(`hunk 起点 ${hunk.oldStart} 越界或与前一个 hunk 重叠`);
    }
    out.push(...original.slice(cursor, start));
    let at = start;
    let added = 0;

    for (const body of hunk.body) {
      const marker = body[0];
      const text = body.slice(1);
      if (marker === '+') {
        out.push(text);
        added += 1;
        continue;
      }
      if (at >= original.length || original[at] !== text) {
        throw new Error(`hunk 上下文不匹配（原文件第 ${at + 1} 行）：补丁可能基于旧版本`);
      }
      if (marker === ' ') out.push(text);
      // '-' 行校验通过后只推进游标，不输出。
      at += 1;
    }

    const consumed = at - start;
    const produced = consumed - hunk.body.filter(line => line[0] === '-').length + added;
    if (consumed !== hunk.oldCount || produced !== hunk.newCount) {
      throw new Error('hunk 的行数声明与实际内容不一致，拒绝应用');
    }
    cursor = at;
  }

  out.push(...original.slice(cursor));
  const result = out.join('\n') + (trailingNewline ? '\n' : '');
  return crlf ? result.replace(/\n/g, '\r\n') : result;
}

/** 补丁统计：只数 hunk 里的增删行，不读文件。 */
export function diffStats(hunks: readonly UnifiedHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.body) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}
