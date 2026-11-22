/**
 * 权限预设决定「还要不要人点」。
 *
 * 起因（2026-11-22 用户现场反馈）：选了「完全权限」之后，计划仍要手动点
 * 「确认并执行」，执行中每一步写操作还要再点一次——权限那一档已经等于
 * 「这台机器上的操作我都允许」，再问两遍只是重复确认，把审批训练成无脑点击。
 *
 * 反过来，`workspace-write` 不能自动开工：它是「只动授权目录」，不是
 * 「什么都同意」，计划里仍可能有删文件、跑命令。计划审批是唯一能看见
 * 「它准备删什么」的机会，必须留着。
 *
 * 纯函数，两个进程共用：主进程拿它决定 grant 与是否自动批准，渲染层拿它
 * 决定文案。不要在这里读设置或任务状态。
 */

import type { PermissionPreset, StepApprovalMode } from './contracts';

export interface ApprovalPolicy {
  /** 计划产出后是否直接执行，不等人点「确认并执行」。 */
  autoApprovePlan: boolean;
  /** 写进 TaskGrant 的逐步骤审批粒度。 */
  stepApproval: StepApprovalMode;
}

export function approvalPolicyFor(preset: PermissionPreset): ApprovalPolicy {
  if (preset === 'danger-full-access') {
    return { autoApprovePlan: true, stepApproval: 'off' };
  }
  return { autoApprovePlan: false, stepApproval: 'mutating' };
}

/** 界面上这一档要怎么解释，避免「选了完全权限却还在等按钮」的困惑。 */
export function approvalHintFor(preset: PermissionPreset): string {
  const policy = approvalPolicyFor(preset);
  if (policy.autoApprovePlan) return '计划自动批准并执行，步骤不再逐次询问';
  // 只读档写「只有写操作才问」是误导：这一档根本不允许写，含写的计划直接被拒。
  if (preset === 'read-only') return '计划需要你确认一次；计划里若有写入或系统操作会被拒绝';
  return '计划需要你确认一次；执行中只有写操作才问';
}
