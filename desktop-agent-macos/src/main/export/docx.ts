/**
 * Markdown → docx，版式固定在这里。
 *
 * 为什么不让模型直接写 Word：它没有文件工具，也拼不出合法的 OOXML；让它「写
 * 一份 docx」的结果只会是改后缀的文本。所以分工是——模型/会话负责**内容**，
 * 这个文件负责**版式**，两边互不越界。换一份内容、换一条会话，版式一个字都不用改。
 *
 * 只支持会话导出真正会用到的 markdown 子集：标题、段落、引用、列表、表格、
 * 代码块、`**粗体**`、`` `行内代码` ``。多余的语法不求完整支持，但也不许把字吞掉：
 * 认不出来的行按普通段落写进去，宁可朴素，不能丢内容。
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IBorderOptions
} from 'docx';

/** 版式常量。改这里就是改导出模板，和内容无关。 */
const TEMPLATE = {
  /** 正文：中文宋体 / 西文 Times New Roman，五号（10.5pt）。 */
  bodySize: 21,
  codeSize: 18,
  tableSize: 19,
  /** A4，上下 2.54cm、左右 2.2cm。 */
  margin: { top: 1440, bottom: 1440, left: 1247, right: 1247 },
  accent: '1F2328',
  muted: '6B7280',
  line: 'D0D7DE',
  headFill: 'F2F4F7',
  codeFill: 'F6F8FA'
} as const;

const sans = { ascii: 'Helvetica', eastAsia: '黑体', hAnsi: 'Helvetica' };
const serif = { ascii: 'Times New Roman', eastAsia: '宋体', hAnsi: 'Times New Roman' };
const mono = { ascii: 'Consolas', eastAsia: '黑体', hAnsi: 'Consolas' };

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; lines: string[] };

const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^```/;
const TABLE_ROW = /^\|.*\|\s*$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;

function splitCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let buffer = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '\\' && body[i + 1] === '|') {
      buffer += '|';
      i += 1;
      continue;
    }
    if (char === '|') {
      cells.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += char;
  }
  cells.push(buffer.trim());
  return cells;
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', lines: body });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      index += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      const header = splitCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(splitCells(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (index < lines.length && BULLET.test(lines[index])) {
        items.push(BULLET.exec(lines[index])![1].trim());
        index += 1;
      }
      blocks.push({ kind: 'bullets', items });
      continue;
    }

    if (ORDERED.test(line)) {
      const items: string[] = [];
      while (index < lines.length && ORDERED.test(lines[index])) {
        items.push(ORDERED.exec(lines[index])![1].trim());
        index += 1;
      }
      blocks.push({ kind: 'ordered', items });
      continue;
    }

    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index].startsWith('>')) {
        quoted.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    // 普通段落：连续的正文行合到一段，段内的单个换行在 Word 里是空格。
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !HEADING.test(lines[index]) &&
      !BULLET.test(lines[index]) &&
      !ORDERED.test(lines[index]) &&
      !FENCE.test(lines[index]) &&
      !TABLE_ROW.test(lines[index]) &&
      !lines[index].startsWith('>')
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

/**
 * 行内格式：`**粗体**` 与 `` `代码` ``。
 *
 * 只认这两种，其余符号原样保留——会话里出现 `*` 的地方常是乘积或通配符，
 * 一律当语法处理会把技术讨论改坏。
 */
function inlineRuns(text: string, opts: { size: number; bold?: boolean; color?: string; font?: typeof serif }): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      runs.push(
        new TextRun({
          text: text.slice(cursor, start),
          size: opts.size,
          bold: opts.bold,
          color: opts.color,
          font: opts.font ?? serif
        })
      );
    }
    const token = match[0];
    if (token.startsWith('**')) {
      runs.push(
        new TextRun({ text: token.slice(2, -2), size: opts.size, bold: true, color: opts.color, font: opts.font ?? serif })
      );
    } else {
      runs.push(new TextRun({ text: token.slice(1, -1), size: opts.size, bold: opts.bold, font: mono }));
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) {
    runs.push(
      new TextRun({
        text: text.slice(cursor),
        size: opts.size,
        bold: opts.bold,
        color: opts.color,
        font: opts.font ?? serif
      })
    );
  }
  return runs.length > 0 ? runs : [new TextRun({ text: '', size: opts.size, font: opts.font ?? serif })];
}

const HAIRLINE: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: TEMPLATE.line };

function headingParagraph(level: number, text: string, first: boolean): Paragraph {
  if (level === 1) {
    return new Paragraph({
      children: inlineRuns(text, { size: 36, bold: true, color: TEMPLATE.accent, font: sans }),
      spacing: { before: first ? 0 : 240, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEMPLATE.accent, space: 6 } }
    });
  }
  if (level === 2) {
    return new Paragraph({
      children: inlineRuns(text, { size: 28, bold: true, color: TEMPLATE.accent, font: sans }),
      spacing: { before: 280, after: 100 }
    });
  }
  if (level === 3) {
    return new Paragraph({
      children: inlineRuns(text, { size: 24, bold: true, color: TEMPLATE.accent, font: sans }),
      spacing: { before: 200, after: 80 }
    });
  }
  return new Paragraph({
    children: inlineRuns(text, { size: 22, bold: true, color: TEMPLATE.accent, font: sans }),
    spacing: { before: 160, after: 60 }
  });
}

function tableFrom(header: string[], rows: string[][]): Table {
  const columns = Math.max(header.length, ...rows.map(row => row.length), 1);
  const width = Math.floor(100 / columns);
  const cellOf = (text: string, head: boolean): TableCell =>
    new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      shading: head ? { type: ShadingType.CLEAR, fill: TEMPLATE.headFill, color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [
        new Paragraph({
          children: inlineRuns(text, { size: TEMPLATE.tableSize, bold: head, color: head ? TEMPLATE.accent : undefined }),
          spacing: { before: 0, after: 0, line: 260 }
        })
      ]
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: HAIRLINE,
      bottom: HAIRLINE,
      left: HAIRLINE,
      right: HAIRLINE,
      insideHorizontal: HAIRLINE,
      insideVertical: HAIRLINE
    },
    rows: [
      new TableRow({ tableHeader: true, children: header.map(text => cellOf(text, true)) }),
      ...rows.map(row => {
        const filled = [...row];
        while (filled.length < columns) filled.push('');
        return new TableRow({ children: filled.map(text => cellOf(text, false)) });
      })
    ]
  });
}

function blockToParagraphs(block: Block, first: boolean): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'heading':
      return [headingParagraph(block.level, block.text, first)];
    case 'paragraph':
      return block.text.split('\n').map(
        text =>
          new Paragraph({
            children: inlineRuns(text, { size: TEMPLATE.bodySize }),
            spacing: { after: 100, line: 300 },
            indent: { firstLine: 420 }
          })
      );
    case 'bullets':
      return block.items.map(
        item =>
          new Paragraph({
            children: inlineRuns(item, { size: TEMPLATE.bodySize }),
            bullet: { level: 0 },
            spacing: { after: 60, line: 300 }
          })
      );
    case 'ordered':
      return block.items.map(
        item =>
          new Paragraph({
            children: inlineRuns(item, { size: TEMPLATE.bodySize }),
            numbering: { reference: 'export-ordered', level: 0 },
            spacing: { after: 60, line: 300 }
          })
      );
    case 'table':
      return [tableFrom(block.header, block.rows)];
    case 'code': {
      const lines = block.lines.length > 0 ? block.lines : [''];
      return [
        new Paragraph({
          children: lines.map(
            (line, index) =>
              new TextRun({
                text: line,
                font: mono,
                size: TEMPLATE.codeSize,
                ...(index === 0 ? {} : { break: 1 })
              })
          ),
          shading: { type: ShadingType.CLEAR, fill: TEMPLATE.codeFill, color: 'auto' },
          spacing: { before: 80, after: 120, line: 260 },
          indent: { left: 200 }
        })
      ];
    }
    case 'quote':
      return block.lines.map(
        line =>
          new Paragraph({
            children: inlineRuns(line, { size: 19, color: TEMPLATE.muted }),
            indent: { left: 300 },
            spacing: { after: 40, line: 280 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: TEMPLATE.line, space: 8 } }
          })
      );
    default:
      return [];
  }
}

export interface DocxOptions {
  /** 页眉右上角那行字。 */
  header?: string;
  /** 页脚左侧。右侧是页码。 */
  footer?: string;
}

/** Markdown 进，docx 字节出。调用方负责写到哪。 */
export async function markdownToDocx(markdown: string, options: DocxOptions = {}): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const children: Array<Paragraph | Table> = [];
  blocks.forEach((block, index) => {
    const pieces = blockToParagraphs(block, index === 0);
    children.push(...pieces);
    // Word 里表格紧贴下一段会粘在一起，表格后补一个空段当间距。
    if (block.kind === 'table') {
      children.push(new Paragraph({ children: [new TextRun({ text: '', size: 12 })], spacing: { after: 60 } }));
    }
  });

  const doc = new Document({
    creator: 'ThinkFusion',
    title: options.header ?? 'ThinkFusion 导出',
    styles: {
      default: {
        document: {
          run: { font: serif, size: TEMPLATE.bodySize, color: '24292F' },
          paragraph: { spacing: { line: 300, after: 100 } }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: 'export-ordered',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 420, hanging: 240 } } }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: TEMPLATE.margin
          }
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: TEMPLATE.line, space: 4 } },
                children: [
                  new TextRun({
                    text: options.header ?? '',
                    size: 16,
                    color: TEMPLATE.muted,
                    font: { ascii: 'Helvetica', eastAsia: '宋体', hAnsi: 'Helvetica' }
                  })
                ]
              })
            ]
          })
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: `${options.footer ? `${options.footer}　` : ''}第 `,
                    size: 16,
                    color: TEMPLATE.muted,
                    font: { ascii: 'Helvetica', eastAsia: '宋体', hAnsi: 'Helvetica' }
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: TEMPLATE.muted }),
                  new TextRun({
                    text: ' 页 / 共 ',
                    size: 16,
                    color: TEMPLATE.muted,
                    font: { ascii: 'Helvetica', eastAsia: '宋体', hAnsi: 'Helvetica' }
                  }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: TEMPLATE.muted }),
                  new TextRun({
                    text: ' 页',
                    size: 16,
                    color: TEMPLATE.muted,
                    font: { ascii: 'Helvetica', eastAsia: '宋体', hAnsi: 'Helvetica' }
                  })
                ]
              })
            ]
          })
        },
        children
      }
    ]
  });

  return Packer.toBuffer(doc);
}
