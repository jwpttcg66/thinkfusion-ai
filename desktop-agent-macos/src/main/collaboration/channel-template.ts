/**
 * P5-03：新增通道只加 Adapter + 能力声明 + 配置。
 * 这里校验声明，不实现具体 Adapter；网页必须无 system/工具。
 */
import type { AgentCapabilities, CapabilityId } from './domain/types';

export interface ChannelSpec {
  id: string;
  kind: 'web' | 'local' | 'cloud' | 'cli';
  capabilities: AgentCapabilities;
  declaredCapabilities: CapabilityId[];
  requiresLogin: boolean;
}

export function validateChannelSpec(spec: ChannelSpec): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!spec.id.trim()) reasons.push('缺少 id');
  if (spec.kind === 'web' && spec.capabilities.canSystemPrompt) reasons.push('网页不能声明 system');
  if (spec.kind === 'web' && spec.capabilities.canUseTools) reasons.push('网页不能声明工具');
  if (spec.kind === 'web' && spec.requiresLogin && !spec.capabilities.requiresLogin) {
    reasons.push('网页需要登录但声明未标 requiresLogin');
  }
  if (spec.declaredCapabilities.length === 0) reasons.push('没有能力声明');
  return { ok: reasons.length === 0, reasons };
}
