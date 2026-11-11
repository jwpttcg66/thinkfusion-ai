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

/**
 * 「保存文档」：把某个网页源当前页面里的文档与计划提取出来存成本地文件。
 *
 * 和会话导出是两条独立的内容来源：那条读的是应用自己存的会话，这条读的是
 * 网页里正在显示的回答。格式规则沿用同一套——默认 md，点名要 doc 才 docx。
 */
export interface SavePageDocumentInput {
  /** 省略就是当前显示在页面栏里的那个网页源。 */
  sourceId?: string;
  format?: ExportFormat;
  /** 不给就弹系统保存对话框；给绝对路径是给自动化与真机验收用的。 */
  path?: string;
  /** 是否附「页面转录」附录。默认附。 */
  includeTranscript?: boolean;
  /**
   * 只保存这些下标（0 起，对应 `PageExtractPreview.items` 的 `index`）。
   * 不传 = 全部。列表由「保存网页对话」多选框决定，正文仍然由主进程去
   * 页面里现读，界面不传正文。
   */
  documents?: number[];
  /**
   * `merge`（默认）：选中的合成一份文件；
   * `per-item`：选中的每条各存一份文件，放在同一个目录里。
   */
  mode?: 'merge' | 'per-item';
}

/** 页面上提取到的一条对话（提问或回答）；只用于勾选列表，不含正式正文。 */
export interface PageExtractItem {
  index: number;
  /** 提问在聊天里靠右、回答靠左；保存时也按这个角色排版。 */
  role: 'user' | 'assistant';
  /** 第一条标题行；没有就用第一句话，最长 60 字。 */
  title: string;
  /** 前 160 字，已经压成一行，列表里看得出来是哪一条。 */
  excerpt: string;
  chars: number;
}

/**
 * 保存前的预览：像微信多选那样先把页面上能保存的对话列出来，由用户勾选。
 * 只读，不写盘；真正的保存会再读一次页面，避免列表和落盘内容来自两个时刻。
 */
export interface PageExtractPreview {
  sourceId?: string;
  sourceLabel: string;
  pageTitle: string;
  url: string;
  items: PageExtractItem[];
  totalChars: number;
  transcriptChars: number;
}

/** 页面上读到的一条消息：提问或回答。 */
export interface PageDocumentMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** 主进程从网页 DOM 里读出来的原始内容，UI 不填这一份。 */
export interface PageDocumentContent {
  sourceLabel: string;
  pageTitle: string;
  url: string;
  /** 每条助手回答，已经由页面脚本读成 Markdown。 */
  documents: string[];
  /**
   * 按页面顺序排好的问答记录（有提问选择器时才有）。
   * 保存时以它为准；`documents` 仍保留，供只认回答的旧逻辑与计划提取。
   */
  messages?: PageDocumentMessage[];
  /**
   * 这份内容来自一条聊天记录（而不是一页文档）。逐条保存时就算只勾了一条
   * 回答，也要用「答」而不是「文档」的抬头——它本来就是一问一答里的回答。
   */
  chat?: boolean;
  /** 页面完整转录，只用于附录节选。 */
  transcript: string;
}

/**
 * 把页面读到的原始内容整理成勾选列表。
 *
 * 只给「哪一条是什么」：角色、标题、前 160 字、字数。正文不在这里传——
 * 保存时主进程会按勾选的下标再读一次页面，列表只负责让人选对。
 */
export function previewPageDocument(content: PageDocumentContent): PageExtractPreview {
  const messages: PageDocumentMessage[] = content.messages?.length
    ? content.messages
    : content.documents.map(text => ({ role: 'assistant' as const, text }));
  const items = messages.map((message, index) => {
    const text = message.text.trim();
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const heading = lines.find(line => /^#{1,6}\s+\S/.test(line));
    const title = (heading ? heading.replace(/^#{1,6}\s+/, '') : lines[0] ?? '')
      .replace(/[*_`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      index,
      role: message.role,
      title: title || `${message.role === 'user' ? '提问' : '回答'} ${index + 1}`,
      excerpt,
      chars: text.length
    };
  });
  return {
    sourceLabel: content.sourceLabel,
    pageTitle: content.pageTitle,
    url: content.url,
    items,
    totalChars: items.reduce((sum, item) => sum + item.chars, 0),
    transcriptChars: content.transcript.trim().length
  };
}

export interface SavePageDocumentResult {
  path: string;
  format: ExportFormat;
  bytes: number;
  /** 存下来几份文档（助手回答）。 */
  documents: number;
  /** 从文档里识别到的计划类条目数。 */
  planItems: number;
  /** 文档正文的总字数。 */
  chars: number;
  /**
   * `per-item` 模式：每条一个文件。`path` 这时是目录，`files` 是实际写出的
   * 文件清单（界面要说清楚「存了 3 个文件」，不能只说一个 path）。
   */
  files?: Array<{ path: string; bytes: number; documents: number }>;
}

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
