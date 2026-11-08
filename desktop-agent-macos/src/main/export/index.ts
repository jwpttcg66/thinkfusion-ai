/**
 * 导出的入口：读会话 → 拼内容 → 排版 → 落盘。
 *
 * 全程在本机完成，没有一个字经过模型：正文是这条会话已经存下来的回答，
 * 排版是模板，写文件是主进程的 fs。用户按下按钮之后，文件就在磁盘上了。
 *
 * 保存位置两条路：
 * - 默认弹系统对话框（用户自己选，可能是桌面，也可能是网盘目录）；
 * - 传了 `path` 就直接写——对话框在自动化里点不了，真机验收走这条。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Conversation, ConversationMessage } from '../../shared/conversation';
import {
  defaultExportName,
  ensureExtension,
  type ExportConversationInput,
  type ExportConversationResult
} from '../../shared/export';
import { writeBufferAtomic, writeFileAtomic } from '../atomic-write';
import { markdownToDocx } from './docx';
import { buildConversationMarkdown } from './markdown';

export interface ExportDeps {
  conversation(id: string): Conversation | null | undefined;
  messages(id: string): ConversationMessage[];
  /** 通道 id → 显示名。 */
  labels(): Record<string, string>;
  /** 保存对话框的起始目录（一般是「下载」）。 */
  defaultDir(): string;
  /** 弹保存对话框；返回 null 表示用户取消。 */
  pickPath?(defaultName: string, format: ExportConversationInput['format']): Promise<string | null>;
}

export async function exportConversation(
  input: ExportConversationInput,
  deps: ExportDeps
): Promise<ExportConversationResult | null> {
  const conversation = deps.conversation(input.conversationId);
  if (!conversation) throw new Error('这条会话已经不在了，没法导出');
  const messages = deps.messages(input.conversationId);

  const markdown = buildConversationMarkdown({
    conversation,
    messages,
    labels: deps.labels(),
    includeEvidence: input.includeEvidence
  });

  const name = defaultExportName(conversation.title, Date.now(), input.format);
  let target: string;
  if (input.path) {
    target = path.isAbsolute(input.path) ? input.path : path.join(deps.defaultDir(), input.path);
  } else {
    const picked = await deps.pickPath?.(name, input.format);
    if (!picked) return null;
    target = picked;
  }
  target = ensureExtension(target, input.format);

  let bytes: number;
  if (input.format === 'docx') {
    const buffer = await markdownToDocx(markdown, {
      header: conversation.title,
      footer: 'ThinkFusion 本机导出'
    });
    writeBufferAtomic(target, buffer);
    bytes = buffer.byteLength;
  } else {
    writeFileAtomic(target, markdown, 0o644);
    bytes = fs.statSync(target).size;
  }

  return {
    path: target,
    format: input.format,
    bytes,
    turns: messages.filter(message => message.role === 'user').length
  };
}
