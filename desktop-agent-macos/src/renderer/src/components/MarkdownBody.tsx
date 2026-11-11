import React from 'react';
import { parseBlocks, type Block } from '../../../shared/markdown';

/**
 * 把一段来源回答按 Markdown 的读法排出来。
 *
 * 为什么不是一段 `white-space: pre-wrap` 的纯文本：站点给的是排版好的答案，
 * 标题、条目、表格、代码块都靠 DOM 结构表达。纯文本一放，全都退化成一大段
 * 文字——用户的原话是「没有 web 页面那么工整，看着不舒服」。
 *
 * 解析在 `shared/markdown.ts`（纯函数，能被 npm test 直接跑到）；这里只管
 * 把块画成元素。任何认不出的行都退回段落，绝不让内容消失。
 */

/** 行内标记：加粗、行内代码、链接。其余原样，避免把正常文字里的星号吃成斜体。 */
function inline(text: string): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  const parts = text.split(pattern);
  return parts.filter(part => part !== undefined && part !== '').map((part, index) => {
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) return <strong key={index}>{bold[1]}</strong>;

    const code = part.match(/^`([^`]+)`$/);
    if (code) return <code key={index} className="md-inline-code">{code[1]}</code>;

    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) {
      return (
        <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

/**
 * 把模型习惯输出的 LaTeX 定界符换成可读排版。
 *
 * 不引入数学排版库：这些公式本来就是给人看的，原样显示只会露出一串
 * `\(` `\times`。行内公式变成行内代码，独立公式变成代码块，至少和周围
 * 文字区分得开；常见命令换成 Unicode，剩下的原样保留（不猜、不删内容）。
 */
function normalizeFormula(body: string): string {
  return body
    // 先处理更长的命令：`\cdots` 里包含 `\cdot`，顺序反了会变成「·s」。
    .replace(/\\cdots|\\dots/g, '…')
    .replace(/\\underbrace\{([^{}]*)\}_\{([^{}]*)\}/g, '$1（$2）')
    .replace(/\\times/g, '×')
    .replace(/\\cdot/g, '·')
    .replace(/\\quad/g, ' ')
    .replace(/\\leq?/g, '≤')
    .replace(/\\geq?/g, '≥')
    .replace(/\\neq/g, '≠')
    .replace(/\\pm/g, '±')
    .replace(/\\(?:to|rightarrow)/g, '→');
}

function normalizeMath(text: string): string {
  const fence = (body: string) => `\n\`\`\`\n${normalizeFormula(body.trim())}\n\`\`\`\n`;
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => fence(body))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `\`${normalizeFormula(body.trim())}\``)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_match, body: string) => fence(body));
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      // 站点的一级标题在卡片里不该比卡片标题还大，所以统一下沉两级。
      const Tag = (`h${Math.min(block.level + 2, 6)}`) as 'h3';
      return <Tag className={`md-heading md-h${String(block.level)}`}>{inline(block.text)}</Tag>;
    }
    case 'code':
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{inline(item)}</li>);
      return block.ordered ? <ol className="md-list">{items}</ol> : <ul className="md-list">{items}</ul>;
    }
    case 'quote':
      return <blockquote className="md-quote">{inline(block.text)}</blockquote>;
    case 'rule':
      return <hr className="md-rule" />;
    default:
      return <p className="md-paragraph">{inline(block.text)}</p>;
  }
}

export function MarkdownBody({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(normalizeMath(text ?? '')), [text]);
  if (blocks.length === 0) return <p className="md-paragraph">（这条回答没有正文）</p>;
  return (
    <div className="md-body">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}
