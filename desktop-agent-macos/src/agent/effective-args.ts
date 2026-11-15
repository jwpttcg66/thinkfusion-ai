/**
 * 把「配置名」展开成「这一步真的会启动什么」。
 *
 * 原来审批卡只有 `tool` + `argsPreview`（cli / task / cwd / timeoutMs 的 JSON）。
 * 用户点「执行这一步」时并不知道实际会跑哪个可执行文件、带什么权限参数、
 * 落在哪个目录。审核要求确认的是**最终有效参数**，不是计划里那个配置名。
 *
 * 纯函数、无 IO，便于单测；不承担授权判断（那是 assertGrant 的事）。
 */

import path from 'node:path';
import { effectivePermissionMode, redactArgv, type EffectiveExecution } from '../shared/redact';
import type { TaskGrant } from '../shared/contracts';
import type { CliAgentConfig } from '../shared/cli-agents';

export interface EffectiveInput {
  tool: string;
  args: Record<string, unknown>;
  grant: TaskGrant;
  cliAgents: readonly CliAgentConfig[];
  risk: 'read' | 'write' | 'danger';
}

/** 计划里的相对 cwd 展开成真实执行目录；越界由 assertGrant 在执行前拦。 */
export function resolveStepCwd(grant: TaskGrant, relativeCwd: unknown): string {
  const root = grant.worktreeDir ?? grant.rootDir;
  if (typeof relativeCwd !== 'string' || !relativeCwd.trim()) return root;
  return path.resolve(root, relativeCwd);
}

/**
 * 展开 `agent.exec` 的最终 argv。
 *
 * 与 `cli-agent.ts` 里的启动逻辑必须一致：`{task}` 是唯一占位符，权限参数
 * 追加在末尾，任务文本原样作为一个 argv 项，不经过 shell。
 */
export function expandCliArgv(config: CliAgentConfig, task: string): string[] {
  const argv: string[] = [];
  for (const item of config.args) argv.push(item === '{task}' ? task : item);
  argv.push(...(config.permissionArgs ?? []));
  return argv;
}

export function buildEffectiveExecution(input: EffectiveInput): EffectiveExecution {
  const cwd = resolveStepCwd(input.grant, input.args.cwd);
  const base: EffectiveExecution = {
    cwd,
    allowsWrites: input.risk !== 'read',
    highRisk: input.risk === 'danger'
  };
  if (input.tool !== 'agent.exec') return base;

  const cli = typeof input.args.cli === 'string' ? input.args.cli : '';
  const config = input.cliAgents.find(item => item.id === cli);
  if (!config) {
    return {
      ...base,
      cli,
      note: '注册表里没有这个 CLI 的配置，执行时会被明确拒绝；这里无法展开启动参数'
    };
  }

  const task = typeof input.args.task === 'string' ? input.args.task : '';
  const permission = effectivePermissionMode(config.permissionArgs);
  return {
    ...base,
    cli: config.label,
    argv: redactArgv([config.command, ...expandCliArgv(config, task)]),
    ...(permission.mode ? { permissionMode: permission.mode } : {}),
    allowsWrites: permission.allowsWrites,
    highRisk: permission.highRisk || base.highRisk === true,
    note: '以上为注册表展开后的实际参数；任务文本已脱敏'
  };
}
