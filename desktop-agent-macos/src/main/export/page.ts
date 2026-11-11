/**
 * 「保存文档」的落盘一步：把网页里读到的内容写成一份本地文件。
 *
 * 内容来自主进程在网页 DOM 里跑的探针（PageDocumentContent），版式沿用会话
 * 导出那套模板；默认 Markdown，只有明确点名 Word 才加载 docx 生成器。
 *
 * 保存前界面会先用 `previewPageDocument` 列出可勾选的对话。保存时只认下标，
 * 正文仍然在这里从页面现读——界面不把网页内容抄出来再传一遍。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  defaultExportName,
  ensureExtension,
  EXPORT_EXTENSIONS,
  resolveExportFormat,
  type ExportFormat,
  type PageDocumentContent,
  type PageDocumentMessage,
  type SavePageDocumentInput,
  type SavePageDocumentResult
} from '../../shared/export';
import { writeBufferAtomic, writeFileAtomic } from '../atomic-write';
import { buildPageDocument } from './page-document';

export interface SavePageDocumentDeps {
  /** 保存对话框的起始目录（一般是「下载」）。 */
  defaultDir(): string;
  /** 不传 path 时弹对话框；返回 null 表示用户取消。 */
  pickPath?(defaultName: string, format: ExportFormat): Promise<string | null>;
  /** `per-item` 模式：选一个目录，把每条对话各存成一个文件。 */
  pickDirectory?(defaultName: string): Promise<string | null>;
}

/** 只留下合法下标，去重并保持页面顺序。 */
function pickIndexes(requested: unknown, total: number): number[] {
  if (!Array.isArray(requested)) return Array.from({ length: total }, (_, index) => index);
  const wanted = new Set(
    requested
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value >= 0 && value < total)
  );
  return [...wanted].sort((left, right) => left - right);
}

export async function savePageDocument(
  input: SavePageDocumentInput,
  content: PageDocumentContent,
  deps: SavePageDocumentDeps
): Promise<SavePageDocumentResult | null> {
  const format = resolveExportFormat(input.format);
  const fromChat = Boolean(content.messages?.length);
  // 勾选下标指向「问答记录」；没有提问选择器的站点退化成只有回答的列表。
  const all: PageDocumentMessage[] = (content.messages?.length
    ? content.messages
    : content.documents.map(text => ({ role: 'assistant' as const, text }))
  )
    .map(message => ({ role: message.role, text: message.text.trim() }))
    .filter(message => message.text.length > 0);
  const indexes = pickIndexes(input.documents, all.length);
  if (indexes.length === 0) throw new Error('这一页没有可保存的对话（可能停在登录页或空会话）');

  const now = Date.now();
  if (input.mode === 'per-item') {
    return savePerItem(input, content, all, indexes, format, now, fromChat, deps);
  }

  const selectedMessages = indexes.map(index => all[index]);
  const selected: PageDocumentContent = {
    ...content,
    documents: selectedMessages.filter(message => message.role === 'assistant').map(message => message.text),
    messages: selectedMessages,
    chat: fromChat
  };
  const draft = buildPageDocument(selected, { includeTranscript: input.includeTranscript });

  const name = defaultExportName(content.pageTitle || content.sourceLabel, now, format);
  let target: string;
  if (input.path) {
    target = path.isAbsolute(input.path) ? input.path : path.join(deps.defaultDir(), input.path);
  } else {
    const picked = await deps.pickPath?.(name, format);
    if (!picked) return null;
    target = picked;
  }
  target = ensureExtension(target, format);

  const bytes = await writeDocument(target, draft.markdown, content, format);

  return {
    path: target,
    format,
    bytes,
    documents: draft.documents,
    planItems: draft.planItems.length,
    chars: draft.chars
  };
}

/**
 * 逐条保存：选一个目录，每条对话一个文件。
 *
 * 不附「页面转录」——同一份转录在每个文件里复制一遍，等于把 N 个文件都
 * 撑大、还让人以为每条对话都包含整段聊天。要完整转录就选「合并保存」。
 */
async function savePerItem(
  input: SavePageDocumentInput,
  content: PageDocumentContent,
  all: PageDocumentMessage[],
  indexes: number[],
  format: ExportFormat,
  now: number,
  fromChat: boolean,
  deps: SavePageDocumentDeps
): Promise<SavePageDocumentResult | null> {
  const name = defaultExportName(content.pageTitle || content.sourceLabel, now, format);
  const base = name.slice(0, name.length - EXPORT_EXTENSIONS[format].length);
  let dir: string;
  if (input.path) {
    dir = path.isAbsolute(input.path) ? input.path : path.join(deps.defaultDir(), input.path);
  } else {
    const picked = await deps.pickDirectory?.(base);
    if (!picked) return null;
    dir = picked;
  }
  fs.mkdirSync(dir, { recursive: true });

  const files: Array<{ path: string; bytes: number; documents: number }> = [];
  let planItems = 0;
  let chars = 0;
  for (const index of indexes) {
    const message = all[index];
    const single: PageDocumentContent = {
      ...content,
      documents: message.role === 'assistant' ? [message.text] : [],
      messages: [message],
      chat: fromChat
    };
    const draft = buildPageDocument(single, { includeTranscript: false });
    const target = path.join(dir, `${base}-${String(index + 1)}${EXPORT_EXTENSIONS[format]}`);
    const bytes = await writeDocument(target, draft.markdown, single, format);
    files.push({ path: target, bytes, documents: draft.documents });
    planItems += draft.planItems.length;
    chars += draft.chars;
  }

  return {
    path: dir,
    format,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    documents: indexes.length,
    planItems,
    chars,
    files
  };
}

/** 写一份文档；Word 生成器按需加载，只在点名 docx 时才付这份代价。 */
async function writeDocument(
  target: string,
  markdown: string,
  content: PageDocumentContent,
  format: ExportFormat
): Promise<number> {
  if (format === 'docx') {
    const { markdownToDocx } = await import('./docx');
    const buffer = await markdownToDocx(markdown, {
      header: content.pageTitle || content.sourceLabel,
      footer: 'ThinkFusion 从网页提取'
    });
    writeBufferAtomic(target, buffer);
    return buffer.byteLength;
  }
  writeFileAtomic(target, markdown, 0o644);
  return fs.statSync(target).size;
}
