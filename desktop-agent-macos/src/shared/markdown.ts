/**
 * 把一段来源回答切成可以渲染的块。
 *
 * 为什么放在 shared：这段解析只处理字符串，和 React 无关，放在这里才能被
 * `npm test` 直接跑到。解析规则是从真机上一条条试出来的（表格的两种形状、
 * 列表项里套段落、话轮标记被当成标题），每一种都值得钉一条用例。
 *
 * 为什么不用成熟的 Markdown 库：这段文本来自别人家的页面，本来就不保证是
 * 合法 Markdown。宽松、短、任何一行解析失败都退回段落——宁可少认一个语法，
 * 不能让内容消失。
 */

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*•·]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,3})(?:[、)]\s*|[.]\s+)(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
// 以竖线开头的行。行尾不一定有竖线：Kimi 的表头读出来是「| 对比点  | HTTP  | HTTPS」，
// 最后一个单元格后面没有收尾的竖线。
const PIPE_ROW = /^\s*\|(.*)$/;
const PIPE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;
const LOOSE_MARKER = /^\s*[-*•·]\s*$/;
/** 只有一个竖线的行：站点表格的分隔符被单独读了出来，既不是表行也不是正文。 */
const BARE_PIPE = /^\s*\|+\s*$/;

/**
 * 收集一段表格行。
 *
 * 表行之间可能夹着空行（站点把每个单元格包成段落，段落之间本来就空一行），
 * 也可能夹着一个孤零零的竖线。这些都不该把一张表截成三段。
 */
function collectPipeRows(lines: string[], start: number): { rows: string[][]; end: number } | null {
  if (!PIPE_ROW.test(lines[start])) return null;
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    // 分隔行要先认：整行只有竖线、短横线和空格，它同时满足「表行」的形状。
    if (PIPE_DIVIDER.test(line) && line.includes('-')) {
      index += 1;
      continue;
    }
    // 只有竖线的行也要先认，否则它会被当成「表头一个格子」。
    if (BARE_PIPE.test(line)) {
      index += 1;
      continue;
    }
    if (PIPE_ROW.test(line)) {
      rows.push(splitPipeRow(line));
      index += 1;
      continue;
    }
    if (line.trim() === '') {
      let next = index + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next < lines.length && (PIPE_ROW.test(lines[next]) || BARE_PIPE.test(lines[next]))) {
        index = next;
        continue;
      }
    }
    break;
  }
  return rows.length > 0 ? { rows, end: index } : null;
}

/** tab 分隔的「伪表格」：一行两列以上，且不是缩进代码。 */
function tabbedCells(line: string): string[] | null {
  if (!line.includes('\t')) return null;
  const cells = line.split('\t').map(cell => cell.trim());
  if (cells.filter(cell => cell.length > 0).length < 2) return null;
  return cells;
}

function splitPipeRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

/**
 * 把「只有一个符号的列表行」和它的内容接起来。
 *
 * 站点常把列表项写成「列表项里再套一层段落」，早先抓下来的文本就长成
 * 「短横线独占一行、内容在下一行」。Markdown 里那是一个空列表项，渲染出来
 * 只剩一个点。抓取端已经改了，但历史数据还在盘上——这里兜住。
 */
function joinLooseMarkers(lines: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (LOOSE_MARKER.test(lines[index])) {
      let next = index + 1;
      while (next < lines.length && lines[next].trim().length === 0) next += 1;
      if (next < lines.length && !LOOSE_MARKER.test(lines[next])) {
        out.push(`- ${lines[next].trim()}`);
        index = next;
        continue;
      }
    }
    out.push(lines[index]);
  }
  return out;
}

export function parseBlocks(markdown: string): Block[] {
  const lines = joinLooseMarkers((markdown ?? '').replace(/\r\n?/g, '\n').split('\n'));
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // 代码块必须最先认：里面可以有竖线、井号、短横线这些在别处有含义的字符。
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾的围栏
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    // 表格。两种形状都要认：
    //
    // 1. 标准 Markdown——表头行、分隔行（`| --- |`）、数据行；
    // 2. 我们自己从页面抓出来的——每行都是 `| a | b |`，没有分隔行，行与行
    //    之间还夹着空行（站点把每个单元格包成段落，段落之间本来就空一行）。
    //
    // 少于两行不算表：一句话里带个竖线只是排版，把一句话变成一张表更糟。
    {
      const collected = collectPipeRows(lines, index);
      if (collected && collected.rows.length >= 2) {
        blocks.push({
          kind: 'table',
          head: collected.rows[0],
          rows: collected.rows.slice(1)
        });
        index = collected.end;
        continue;
      }
    }

    const tabCells = tabbedCells(line);
    // 一行里带个 tab 只是排版；连着两行以上才是表格，否则会把一句话变成一张表。
    if (tabCells && index + 1 < lines.length && tabbedCells(lines[index + 1])) {
      const rows: string[][] = [tabCells];
      index += 1;
      while (index < lines.length) {
        const next = tabbedCells(lines[index]);
        if (!next) break;
        rows.push(next);
        index += 1;
      }
      const width = Math.max(...rows.map(row => row.length));
      const padded = rows.map(row => [...row, ...Array<string>(width - row.length).fill('')]);
      // 站点自己的第一行就是表头（「维度 / Go / Java」），不当成数据行。
      blocks.push({ kind: 'table', head: padded[0], rows: padded.slice(1) });
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        body.push(lines[index].match(QUOTE)![1]);
        index += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const matched = lines[index].match(BULLET);
        if (matched) {
          items.push(matched[1].trim());
          index += 1;
          continue;
        }
        // 列表项之间隔了空行还是同一个列表，否则一个 8 条的列表会变成 8 个列表。
        if (lines[index].trim() === '' && index + 1 < lines.length && BULLET.test(lines[index + 1])) {
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    if (ORDERED.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const matched = lines[index].match(ORDERED);
        if (matched) {
          items.push(matched[2].trim());
          index += 1;
          continue;
        }
        if (lines[index].trim() === '' && index + 1 < lines.length && ORDERED.test(lines[index + 1])) {
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    // 普通段落：连续的非空、非语法行合成一段。
    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !HEADING.test(lines[index]) &&
      !BULLET.test(lines[index]) &&
      !ORDERED.test(lines[index]) &&
      !QUOTE.test(lines[index]) &&
      !RULE.test(lines[index]) &&
      !/^\s*```/.test(lines[index]) &&
      !PIPE_ROW.test(lines[index]) &&
      !tabbedCells(lines[index])
    ) {
      // 段内保留单换行：来源是网页文本，单换行往往是作者真的换了一行。
      // 配合 `.md-paragraph` 的 pre-wrap，认不出任何标记时渲染结果和纯文本一致。
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}
