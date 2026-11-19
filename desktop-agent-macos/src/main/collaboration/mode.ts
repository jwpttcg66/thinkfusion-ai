/**
 * 协作引擎的运行模式。
 *
 * legacy：完全走现有 MasterAgent 路径（默认，回滚目标）。
 * shadow：旧路径照常执行；新 Planner 只算计划，不调用模型、不执行任务。
 * active：新引擎执行；旧路径保留为回退开关。
 *
 * 文件只存模式与更新时间；不在这里接 UI、不在这里发事件。
 * 读取失败、损坏、非法值一律回 legacy——启动读失败不该让应用起不来。
 */
import fs from 'node:fs';
import { writeFileAtomic } from '../atomic-write';
import { canRequestMode, type ShadowMetrics } from './gate';

export type CollaborationMode = 'legacy' | 'shadow' | 'active';

export const COLLABORATION_MODES: readonly CollaborationMode[] = ['legacy', 'shadow', 'active'];

export function normalizeCollaborationMode(value: unknown): CollaborationMode {
  if (typeof value !== 'string') return 'legacy';
  const next = value.trim().toLowerCase();
  return (COLLABORATION_MODES as readonly string[]).includes(next)
    ? (next as CollaborationMode)
    : 'legacy';
}

export function collaborationModePath(userDataDir: string): string {
  return `${userDataDir}/collaboration-mode.json`;
}

interface StoredMode {
  mode?: unknown;
  updatedAt?: unknown;
  source?: unknown;
}

export class CollaborationModeStore {
  constructor(private readonly file: string) {}

  get(): CollaborationMode {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'legacy';
      return normalizeCollaborationMode((parsed as StoredMode).mode);
    } catch {
      return 'legacy';
    }
  }

  /** 设置 active 前必须过门禁；legacy/shadow 不拦。 */
  setGated(mode: unknown, metrics: ShadowMetrics, source = 'settings'): CollaborationMode {
    const next = normalizeCollaborationMode(mode);
    const check = canRequestMode(next, metrics);
    if (!check.ok) throw new Error(`active 门禁未通过：${check.reasons.join('；')}`);
    return this.set(next, source);
  }

  set(mode: unknown, source = 'settings'): CollaborationMode {
    const next = normalizeCollaborationMode(mode);
    writeFileAtomic(
      this.file,
      JSON.stringify({ mode: next, updatedAt: Date.now(), source }, null, 2),
      0o600
    );
    return next;
  }
}
