/**
 * 把一条会话导出成文件。
 *
 * 导出是**本机**做的事：主进程读自己存的会话与消息，自己把内容排版成文件，
 * 只有选保存位置这一步交给系统对话框。所以「文档由真机自己保存」这句话在
 * 实现上成立——没有任何一步需要模型参与，也不需要把正文复制到别处再拼。
 *
 * 两种格式各有各的用法：
 * - `md`   纯文本、可 diff、能被任何工具读，缺点是排版要靠读的人自己渲染；
 * - `docx` 版式由模板决定（字体、标题层级、表格边框、页脚页码），正文内容
 *          照原样进来，不因为换格式而改写任何一句话。
 *
 * 默认是 `md`：不点名要 Word，就不生成 Word。会话里存的就是文字，Markdown
 * 是它最直接的落地形式，也不会因为模板升级而变样；Word 是「用户明确要交一份
 * 排好版的文档」时才走的分支。
 */

import type { ConversationExecutionConfig } from './conversation';

export type ExportFormat = 'md' | 'docx';

/** 不指定格式时存成什么。 */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'md';

/**
 * 把外面传进来的格式收敛成一个确定值。
 *
 * 只有明确说 Word 才给 docx（`docx` / `doc` / `word` 都算，大小写不敏感——
 * 用户嘴里和文件名里更常写 `.doc`）；其余一律 md，包括没传、传了不认识的
 * 值。宁可存一份能打开的文本文档，也不要因为格式名写错而生成一个空的 Word。
 */
export function resolveExportFormat(value: unknown): ExportFormat {
  if (typeof value !== 'string') return DEFAULT_EXPORT_FORMAT;
  return /^(docx?|word)$/i.test(value.trim()) ? 'docx' : DEFAULT_EXPORT_FORMAT;
}

export interface ExportConversationInput {
  conversationId: string;
  /** 省略就是 md。 */
  format?: ExportFormat;
  /**
   * 目标路径。不给就弹系统保存对话框。
   *
   * 给路径这条路是留给自动化和真机验收用的：对话框在无人值守时无法点。
   */
  path?: string;
  /** 是否附上工程证据清单（读了哪些文件的哪一行）。默认附。 */
  includeEvidence?: boolean;
}

export interface ExportConversationResult {
  path: string;
  format: ExportFormat;
  bytes: number;
  /** 这份文件里装了几轮问答。界面上直接说「导出了 3 轮」。 */
  turns: number;
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { md: '.md', docx: '.docx' };

/** 对话框里的格式名。文件名后缀另算，这里说的是「另存为」那一栏写什么。 */
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { md: 'Markdown', docx: 'Word' };

export const EXECUTION_MODE_LABELS: Record<ConversationExecutionConfig['executionMode'], string> = {
  web: '网页主导',
  local: '本地主导',
  cloud: '云端主导',
  hybrid: '混合主导'
};

/** `2026-11-08 16:30` —— 导出文件里出现的所有时间都用这一个写法。 */
export function formatStamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function defaultExportName(title: string, at: number, format: ExportFormat): string {
  // 标题来自用户的第一句话，可能带 `/`、`:`、换行——放进去会让对话框把
  // 后半截当成目录或直接拒绝。这里只保留能安全出现在文件名里的字符。
  const cleaned =
    (title || '会话')
      .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .trim() || '会话';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${cleaned}-${stamp}${EXPORT_EXTENSIONS[format]}`;
}

/**
 * 让路径的后缀和所选格式一致。
 *
 * 用户在对话框里把名字改成 `报告.txt` 时，写进去的是一份 Markdown——后缀
 * 说谎比文件写坏更麻烦：双击打不开，还以为是导出坏了。
 */
export function ensureExtension(path: string, format: ExportFormat): string {
  const suffix = EXPORT_EXTENSIONS[format];
  return path.toLowerCase().endsWith(suffix) ? path : `${path}${suffix}`;
}
