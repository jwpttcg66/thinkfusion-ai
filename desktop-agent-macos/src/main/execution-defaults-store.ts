import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write';
import {
  DEFAULT_EXECUTION_CONFIG,
  normalizeExecutionConfig,
  type ConversationExecutionConfig
} from '../shared/conversation';

/**
 * 研究设置里「跨会话还记得」的那一份：主导人、参与的云端模型等。
 *
 * 会话自己的 `executionConfig` 只跟着那条线程；关掉应用、点「新对话」时，
 * 人期望的是「我上次勾的那几个还在」，不是退回「全部参与」或「一个都没选
 * 却装作全选」。这份文件就是那个记忆。
 *
 * 默认云端参与是空数组——OpenCode Go 一家就有几十个模型，默认全开等于
 * 每一次提问都把额度打光。用户勾了什么，就按什么跑。
 */

export class ExecutionDefaultsStore {
  constructor(private readonly file: string) {}

  /**
   * 读盘。文件不存在 / 损坏时退回代码默认值（云端参与 = 空），
   * 不抛——启动读失败不该让整个应用起不来。
   */
  get(): ConversationExecutionConfig {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...DEFAULT_EXECUTION_CONFIG };
      }
      return normalizeExecutionConfig(parsed as Partial<ConversationExecutionConfig>);
    } catch {
      return { ...DEFAULT_EXECUTION_CONFIG };
    }
  }

  /**
   * 整份覆盖写盘。调用方应先 `normalizeExecutionConfig`，这里再收一次，
   * 避免半截对象把非法字段带进下次启动。
   */
  set(input: Partial<ConversationExecutionConfig>): ConversationExecutionConfig {
    const next = normalizeExecutionConfig(input);
    writeFileAtomic(this.file, JSON.stringify(next, null, 2), 0o600);
    return next;
  }
}
