/**
 * 唯一一处把专家 / 技能拼进 system 的地方。
 *
 * 三条边界，任何一条破了都会回到「给网页塞固定提示词」那条老路上：
 *
 * - 只在工程空间（workspaceMode === 'engineering'）返回内容；知识空间返回空。
 * - 只返回 system 行，**不碰 question**。用户原话与网页通道一个字都不改。
 * - 专家是常驻人设；技能按 `shouldLoadEngineeringSkill` 命中才拼进去。
 *
 * 网页通道收不到 system，所以这里天然只影响本地 / 云端模型的第一意见。
 */

import type { ExpertiseId } from '../../shared/expertise';
import type { WorkspaceMode } from '../../shared/workspace';
import { docOf, type ExpertiseState } from './loader';
import { shouldLoadEngineeringSkill } from './trigger';

export interface BuildExpertiseInput {
  workspaceMode: WorkspaceMode | undefined;
  question: string;
  state: ExpertiseState;
  disabled: readonly string[];
}

export interface BuiltExpertise {
  /** 追加到 engineeringAnswerSystem() 之后的 system 段。 */
  system: string[];
  /** 只有真正加载了技能才给一条系统消息；默认状态不刷屏。 */
  note: string;
  loaded: ExpertiseId[];
}

export function buildEngineeringExpertise(input: BuildExpertiseInput): BuiltExpertise {
  const empty: BuiltExpertise = { system: [], note: '', loaded: [] };
  if (input.workspaceMode !== 'engineering') return empty;

  const off = new Set(input.disabled);
  const lines: string[] = [];
  const loaded: ExpertiseId[] = [];

  const expert = docOf(input.state, 'senior-developer');
  if (!off.has('senior-developer') && !expert.error && expert.body.trim()) {
    lines.push(`【当前专家】${expert.meta.title}（${expert.meta.version}）`, expert.body);
    loaded.push('senior-developer');
  }

  const skill = docOf(input.state, 'engineering-design');
  const trigger = shouldLoadEngineeringSkill(input.question);
  if (!off.has('engineering-design') && !skill.error && skill.body.trim() && trigger.load) {
    lines.push(`【本次加载的技能】${skill.meta.title}（${skill.meta.version}）`, skill.body);
    loaded.push('engineering-design');
  }

  return {
    system: lines,
    note: loaded.includes('engineering-design')
      ? `已加载技能「${skill.meta.title}」：${trigger.reason}`
      : '',
    loaded
  };
}
