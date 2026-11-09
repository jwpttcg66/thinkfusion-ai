/**
 * 输入框「＋」里的附件：用户自己挑的本机文件。
 *
 * 这里划的边界和工程证据一样——**附件不是提示词**。用户点了「添加文件」，
 * 那几个文件的内容随这一问一起发出去，这是用户挑的，他知道自己挑了什么。
 * 没有附件时拼出来的字符串与原来的问题逐字相同（`check-prompt-policy` 与
 * `check-attachments` 都盯着这一点），所以不做任何「格式要求」类的包装。
 *
 * 内容是**发送时**才读的：界面只拿到路径与大小，正文不进渲染层、不存进会话。
 * 文件在挑完之后被改掉、删掉，都在发送那一刻如实报错，而不是发一份旧内容。
 */

/** 一条附件引用。只有路径和体积，没有正文。 */
export interface ConversationAttachment {
  /** 路径指纹。同一个文件重复添加还是同一条，不会出现两份。 */
  id: string;
  name: string;
  path: string;
  bytes: number;
  addedAt: number;
}

/** 发送那一刻读出来的正文。`chars` 是真正带上去的字数。 */
export interface AttachmentText extends ConversationAttachment {
  text: string;
  chars: number;
  /** 全文多少字；截断时用来说明「带上去的只是前面一段」。 */
  totalChars: number;
  truncated: boolean;
}

/** 一次最多带几个。再多，网页输入框和模型上下文都装不下。 */
export const MAX_ATTACHMENTS = 6;

/** 单个文件最多带多少字。 */
export const MAX_ATTACHMENT_CHARS = 12_000;

/**
 * 一次提问所有附件加起来的字数上限。
 *
 * 均分而不是「先到先得」：三个文件里只有第一个完整、后两个是零头，用户会
 * 以为另两个没生效。均分之后每份都短，但每份都在。
 */
export const MAX_ATTACHMENT_TOTAL_CHARS = 48_000;

/** 单个文件最多读多大。超过就是选错了文件，直接说，不偷偷读一半。 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const MIN_ATTACHMENT_CHARS = 2_000;

/** 单个文件这一轮实际能带多少字：均分预算，再夹在上下限之间。 */
export function attachmentCharBudget(count: number): number {
  if (count <= 0) return 0;
  const even = Math.floor(MAX_ATTACHMENT_TOTAL_CHARS / count);
  return Math.max(MIN_ATTACHMENT_CHARS, Math.min(MAX_ATTACHMENT_CHARS, even));
}

export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 按路径去重，保留第一次出现的顺序。 */
export function dedupeAttachments<T extends ConversationAttachment>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (!item || typeof item.path !== 'string' || seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
  return out.slice(0, MAX_ATTACHMENTS);
}

/**
 * 用户原话 + 附件正文。
 *
 * 用户的话在最前面，一个字都不改；附件跟在后面，每份带一个标题行（文件名、
 * 体积、是否截断），让读到这段的人知道正文从哪开始、到哪结束。没有附件时
 * 直接返回原话——这是「不发固定提示词」那条硬规则的落点。
 */
export function composeQuestionWithAttachments(
  question: string,
  attachments: readonly AttachmentText[]
): string {
  const head = question.trim();
  if (attachments.length === 0) return head;
  return [head, ...attachmentBlocks(attachments)].join('\n\n');
}

/** 每份附件一段：标题行说明文件与是否截断，正文原样跟在后面。 */
export function attachmentBlocks(attachments: readonly AttachmentText[]): string[] {
  return attachments.map((item, index) => {
    const size = item.truncated
      ? `${describeBytes(item.bytes)}，已带前 ${String(item.chars)} 字 / 全文 ${String(item.totalChars)} 字`
      : `${describeBytes(item.bytes)}，全文`;
    const body = item.text.replace(/\s+$/, '');
    return `【附件 ${String(index + 1)}】${item.name}（${size}）\n${body}`;
  });
}

/**
 * 附件正文单独作为「材料」递进执行阶段（汇总 / 交锋 / 最终意见）。
 *
 * 为什么要单独一份：真机 2026-11-09 抓到——用户附了一份日志并问「分析总行数」，
 * 日志开头就写着总行数，第一手成员也答出了这个数，但最终结论却是「无法确定」。
 * 原因是附件正文只拼在【用户的问题】里，而汇总的纪律写着「只依据各来源的回答」，
 * 于是主导人把它当成「用户的附注」而不是可引用的材料，直接用工程证据把附件
 * 内容否掉了。附件是用户亲手挑的本机文件原文，和工程证据同级，必须作为材料
 * 出现，而不是混在问题里。
 */
export function buildAttachmentMaterial(attachments: readonly AttachmentText[]): string {
  if (attachments.length === 0) return '';
  return [
    '【用户随这一问附上的文件：正文来自用户亲手挑选的本机文件，不是模型推测】',
    ...attachmentBlocks(attachments)
  ].join('\n\n');
}

/** 系统消息里那一行：让用户在会话里看得见「这一问带了哪些文件」。 */
export function describeAttachments(attachments: readonly AttachmentText[]): string {
  const names = attachments.map(item => item.name).join('、');
  const truncated = attachments.filter(item => item.truncated);
  const tail =
    truncated.length > 0
      ? `；其中 ${truncated.map(item => item.name).join('、')} 太长，只带了前面一段`
      : '';
  return `随这一问附上了 ${String(attachments.length)} 个文件：${names}${tail}`;
}
