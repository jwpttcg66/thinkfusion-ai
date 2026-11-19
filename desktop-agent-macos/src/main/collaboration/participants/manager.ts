/**
 * 参与者清单与执行。P1-01：只按名单问人，不再默认全量。
 *
 * 能力声明先按来源给最小集合；P5 再扩到完整注册表。
 */
import type { ChannelStatus } from '../../../shared/conversation';
import type { SubAgentPool } from '../../agents/types';
import type { CapabilityId } from '../domain/types';

export interface ParticipantView {
  participantId: string;
  label: string;
  kind: 'web' | 'local' | 'cloud' | 'cli';
  capabilities: CapabilityId[];
  available: boolean;
  reason?: string;
}

export interface ParticipantRunResult {
  participantId: string;
  status: 'done' | 'failed' | 'skipped';
  text?: string;
  error?: { code: string; message: string };
}

const CAPABILITIES: Record<ParticipantView['kind'], CapabilityId[]> = {
  web: ['knowledge', 'web-research'],
  local: ['reasoning', 'knowledge'],
  cloud: ['reasoning', 'knowledge'],
  cli: ['reasoning']
};

function kindOf(sourceType: string | undefined): ParticipantView['kind'] {
  if (sourceType === 'local' || sourceType === 'cloud' || sourceType === 'cli') return sourceType;
  return 'web';
}

export class ParticipantManager {
  constructor(private readonly pool: SubAgentPool) {}

  async list(): Promise<ParticipantView[]> {
    const agents = await this.pool.all();
    return Promise.all(
      agents.map(async agent => {
        const kind = kindOf(agent.sourceType);
        const status: ChannelStatus = await agent.health();
        return {
          participantId: agent.id,
          label: agent.label,
          kind,
          capabilities: CAPABILITIES[kind],
          available: status.available,
          ...(status.detail ? { reason: status.detail } : {})
        };
      })
    );
  }

  /**
   * 只问给定名单。网页通道只发问题；本地/云端可带结构化 context/system。
   * 不在名单里的成员不会被问。
   */
  async ask(
    participantIds: readonly string[],
    question: string,
    options: { timeoutMs?: number; context?: string[]; system?: string[] } = {}
  ): Promise<ParticipantRunResult[]> {
    const agents = await this.pool.all();
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const out: ParticipantRunResult[] = [];
    for (const id of participantIds) {
      const agent = byId.get(id);
      if (!agent) {
        out.push({ participantId: id, status: 'failed', error: { code: 'UNKNOWN_PARTICIPANT', message: `未知参与者：${id}` } });
        continue;
      }
      const status = await agent.health();
      if (!status.available) {
        out.push({ participantId: id, status: 'skipped', error: { code: 'UNAVAILABLE', message: status.detail ?? '不可用' } });
        continue;
      }
      const isWeb = kindOf(agent.sourceType) === 'web';
      try {
        const answer = await this.pool.ask(id, {
          question,
          stage: 'initial',
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(!isWeb && options.context && options.context.length > 0 ? { context: options.context } : {}),
          ...(!isWeb && options.system && options.system.length > 0 ? { system: options.system } : {})
        });
        out.push({ participantId: id, status: 'done', text: answer.text });
      } catch (error) {
        out.push({
          participantId: id,
          status: 'failed',
          error: { code: 'ASK_FAILED', message: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    return out;
  }
}
