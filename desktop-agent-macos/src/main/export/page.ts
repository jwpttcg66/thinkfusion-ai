/**
 * 「保存文档」的落盘一步：把网页里读到的内容写成一份本地文件。
 *
 * 内容来自主进程在网页 DOM 里跑的探针（PageDocumentContent），版式沿用会话
 * 导出那套模板；默认 Markdown，只有明确点名 Word 才加载 docx 生成器。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  defaultExportName,
  ensureExtension,
  resolveExportFormat,
  type ExportFormat,
  type PageDocumentContent,
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
}

export async function savePageDocument(
  input: SavePageDocumentInput,
  content: PageDocumentContent,
  deps: SavePageDocumentDeps
): Promise<SavePageDocumentResult | null> {
  const format = resolveExportFormat(input.format);
  const draft = buildPageDocument(content, { includeTranscript: input.includeTranscript });

  const name = defaultExportName(content.pageTitle || content.sourceLabel, Date.now(), format);
  let target: string;
  if (input.path) {
    target = path.isAbsolute(input.path) ? input.path : path.join(deps.defaultDir(), input.path);
  } else {
    const picked = await deps.pickPath?.(name, format);
    if (!picked) return null;
    target = picked;
  }
  target = ensureExtension(target, format);

  let bytes: number;
  if (format === 'docx') {
    const { markdownToDocx } = await import('./docx');
    const buffer = await markdownToDocx(draft.markdown, {
      header: content.pageTitle || content.sourceLabel,
      footer: 'ThinkFusion 从网页提取'
    });
    writeBufferAtomic(target, buffer);
    bytes = buffer.byteLength;
  } else {
    writeFileAtomic(target, draft.markdown, 0o644);
    bytes = fs.statSync(target).size;
  }

  return {
    path: target,
    format,
    bytes,
    documents: draft.documents,
    planItems: draft.planItems.length,
    chars: draft.chars
  };
}
