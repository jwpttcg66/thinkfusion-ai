/**
 * 只读 SKILL.md / EXPERT.md 顶上那一小段 frontmatter。
 *
 * 故意不装 YAML 解析器：这两个文件是应用自带的，用户替换时写的也只会是
 * 「key: value」和「key: |」两种形状。引一个 YAML 库进来，等于让一段用户
 * 可编辑的文本拥有执行复杂结构的能力，而这里只需要几个字符串。
 *
 * 解析不出来不抛异常：返回空 fields 和原文，由加载器决定是报错还是降级。
 */

export interface Frontmatter {
  fields: Record<string, string>;
  body: string;
  /** 有没有合法的 --- 包裹。没有就不算一份技能文件。 */
  ok: boolean;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { fields: {}, body: text, ok: false };

  const end = text.indexOf('\n---', 4);
  if (end < 0) return { fields: {}, body: text, ok: false };

  const block = text.slice(4, end).split('\n');
  const body = text.slice(end + 4).replace(/^\n+/, '').trim();
  const fields: Record<string, string> = {};
  let key: string | null = null;
  /** '|' 保留换行，'>' 折叠成空格；普通值不收后续缩进行。 */
  let style: 'literal' | 'folded' | null = null;

  for (const line of block) {
    const indented = /^\s+/.test(line);
    if (indented) {
      // 嵌套块（metadata: 下面的 category 之类）不是我们关心的字段，跳过。
      // 只有块标量的续行才收进当前 key。
      if (key && style) {
        const piece = line.trim();
        if (piece && !piece.startsWith('#')) {
          const glue = style === 'folded' ? ' ' : '\n';
          fields[key] = fields[key] ? `${fields[key]}${glue}${piece}` : piece;
        }
      }
      continue;
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    key = match[1];
    const value = match[2].trim();
    if (value === '|' || value === '>') {
      style = value === '|' ? 'literal' : 'folded';
      fields[key] = '';
    } else {
      style = null;
      fields[key] = unquote(value);
    }
  }

  return { fields, body, ok: true };
}
