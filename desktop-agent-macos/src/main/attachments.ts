/**
 * 附件：把「用户在输入框里挑的文件」变成可以随问题发出去的正文。
 *
 * 三件事刻意分开：
 *
 * - `referenceFiles` 只在挑选那一刻读元信息（名字、体积、路径），返回会话里
 *   存得下的引用；正文不进渲染层，也不进会话存档。
 * - `readAttachmentTexts` 在**发送那一刻**重新读盘。挑完之后文件被改掉、删掉，
 *   都在这里如实报错——发一份挑的时候的旧副本才是更坏的结果。
 * - 二进制文件直接拒绝。读成 UTF-8 的图片是一堆替换字符，模型只会照着幻觉。
 *
 * 没有 Electron 依赖：对话框在 `index.ts` 里弹，这个文件能在 node 测试里直接跑。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  attachmentCharBudget,
  dedupeAttachments,
  describeBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type AttachmentText,
  type ConversationAttachment
} from '../shared/attachments';

/** 同一个路径永远同一个 id：重复添加不会在会话里出现两条。 */
function fingerprint(file: string): string {
  return createHash('sha1').update(file).digest('hex').slice(0, 12);
}

/**
 * 用户挑中的路径 → 会话里存得下的引用。
 *
 * 路径在这里就 `resolve` 成绝对路径：后面发送时不再依赖当前工作目录。
 */
export function referenceFiles(paths: readonly string[], now = Date.now()): ConversationAttachment[] {
  const out: ConversationAttachment[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const file = path.resolve(raw.trim());
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`文件不在了：${path.basename(file)}`);
    }
    if (!stat.isFile()) throw new Error(`${path.basename(file)} 不是文件`);
    out.push({
      id: fingerprint(file),
      name: path.basename(file),
      path: file,
      bytes: stat.size,
      addedAt: now
    });
  }
  return dedupeAttachments(out);
}

/** 二进制判定：前 4 KB 里有 NUL 就当二进制。文本文件不会出现它。 */
function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 4096);
  return probe.includes(0);
}

/**
 * 发送那一刻的正文。
 *
 * 每份按「总预算均分」截断，并标 `truncated`；超过体积上限的直接报错，因为
 * 那通常是选错了文件（视频、安装包），偷偷只读前 4 MB 会让人以为整份都发了。
 */
export function readAttachmentTexts(refs: readonly ConversationAttachment[]): AttachmentText[] {
  const list = dedupeAttachments(refs).slice(0, MAX_ATTACHMENTS);
  const budget = attachmentCharBudget(list.length);

  return list.map(ref => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(ref.path);
    } catch {
      throw new Error(`附件不在了：${ref.name}（${ref.path}）`);
    }
    if (!stat.isFile()) throw new Error(`附件不是文件：${ref.name}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件「${ref.name}」有 ${describeBytes(stat.size)}，超过 ${describeBytes(MAX_ATTACHMENT_BYTES)} 上限`);
    }

    const buffer = fs.readFileSync(ref.path);
    if (looksBinary(buffer)) {
      throw new Error(`附件「${ref.name}」看起来是二进制文件，读不成文字；换成文本、源码或 CSV 再试`);
    }

    const whole = buffer.toString('utf8');
    const truncated = whole.length > budget;
    return {
      ...ref,
      bytes: stat.size,
      text: truncated ? whole.slice(0, budget) : whole,
      chars: truncated ? budget : whole.length,
      totalChars: whole.length,
      truncated
    };
  });
}

/** 挑路径 → 直接读正文。给能力插件 `file.attach` 用的那一步。 */
export function attachFiles(paths: readonly string[]): AttachmentText[] {
  return readAttachmentTexts(referenceFiles(paths));
}
