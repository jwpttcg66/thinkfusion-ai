import type { ChannelStatus } from '../../shared/conversation';
import type { DeleteThreadResult, NewSessionResult } from '../adapters/browser/types';
import type { SubAgent, SubAgentAnswer, SubAgentIdentity, SubAgentTask } from '../agents/types';
import type { ModelProvider } from '../providers/types';

/**
 * 把 `ModelProvider` 包成 `SubAgent`。
 *
 * 这是 Phase E 选的最小改动路径：现有 `MasterAgent` 只认 `SubAgentPool`，
 * 而项目书决策 3 要求不能为了统一 Provider 重写 Web Channel。把新来源往
 * 旧接口上适配，`MasterAgent`、`ConversationRunner`、综合、事件、删除流程
 * 一行都不用改，网页通道继续走原来的 `ProviderSubAgent`。
 *
 * 两个网页特有的方法故意不实现：`newConversation` / `deleteConversation`。
 * 本地和云端每次请求本来就是新会话，也没有「站点侧栏里那一行」可删。
 * `ExecutionPool` 遇到它们会返回「无事可做」而不是伪造一个成功删除。
 */
export class ProviderBackedSubAgent implements SubAgent {
  readonly identity: SubAgentIdentity;
  readonly id: string;
  readonly label: string;

  private seq = 0;

  constructor(
    readonly provider: ModelProvider,
    /** 一个 Provider 可以有多个模型；不给就用它的默认模型。 */
    readonly modelId?: string
  ) {
    this.id = modelId ? `${provider.id}:${modelId}` : provider.id;
    this.label = modelId ? `${provider.label} · ${modelId}` : provider.label;
    this.identity = {
      id: this.id,
      label: this.label,
      kind: 'provider',
      role: provider.type === 'local' ? '本地模型' : provider.type === 'cloud' ? '云端模型' : '模型来源'
    };
  }

  /** 真正的来源类型，选人策略靠它区分，不用 instanceof 猜。 */
  get sourceType(): 'web' | 'local' | 'cloud' {
    return this.provider.type;
  }

  async health(): Promise<ChannelStatus> {
    const status = await this.provider.health();
    return {
      id: this.id,
      label: this.label,
      available: status.available,
      // 本地/云端没有「登录」和「页面」这两个概念。这里写的是「不缺这两样」，
      // 不是假装它们有网页；detail 会把真正的原因带上来。
      loggedIn: status.available,
      pageReady: status.available,
      generating: false,
      detail: status.detail
    };
  }

  async ask(task: SubAgentTask): Promise<SubAgentAnswer> {
    const requestId = `${this.id}-${++this.seq}`;
    const response = await this.provider.generate({
      question: task.question,
      modelId: this.modelId,
      timeoutMs: task.timeoutMs,
      requestId,
      continuation: task.stage === 'followup',
      context: task.context,
      system: task.system
    });
    return {
      agentId: this.id,
      text: response.text,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
      receivedAt: Date.now(),
      attribution: {
        requestId,
        note: `${this.provider.type}:${response.modelId}`
      },
      stage: task.stage,
      usage: response.usage,
      latencyMs: response.latencyMs
    };
  }

  cancel(requestId: string): void {
    this.provider.cancel(requestId);
  }

  /** 供 `ExecutionPool` 用：这两个操作对非网页来源没有对应物。 */
  static noSession(): NewSessionResult {
    return { ok: true, detail: '本地/云端每次请求本身就是新会话' };
  }

  static noThread(): DeleteThreadResult {
    return { ok: true, detail: '本地/云端没有站点侧栏会话可删' };
  }
}
