/**
 * 上下文残留回收（V4 P1 M2-2 垃圾回收）。
 *
 * 两个入口共用一份口径，都只按 owner 段删，不按时间或文件大小猜：
 * - 删除任务时：`agent-task:<taskId>` 这个 owner 的 Journal 指针随任务一起没了，
 *   归属文件再没人寻得到；
 * - 应用启动时：回收逻辑上线之前删掉的任务没有「删除动作」可依，只能按
 *   「任务表里查不到这个段」判定（实测过 0 条任务对应 11 个归属文件）。
 *
 * 只扫 `agent-task`：会话（conversation）的归档属于仍在列表里的对话，
 * 用任务表判它的孤儿会误删用户还在看的会话上下文。
 */

import { contextOwnerSegment, type ContextOwner } from '../../../shared/context';
import type { ContextArchiveStore } from './archive';
import type { ContextCheckpointStore } from './store';

export interface CheckpointCleanup {
  checkpointsRemoved: boolean;
  archiveSegments: number;
}

export interface OrphanCleanupCounts {
  checkpointsRemoved: number;
  archiveSegments: number;
}

/** 回收一个任务的检查点文件与归档段。 */
export async function deleteTaskContextArtifacts(
  store: ContextCheckpointStore,
  archive: ContextArchiveStore,
  owner: ContextOwner
): Promise<CheckpointCleanup> {
  return {
    checkpointsRemoved: await store.deleteOwner(owner),
    archiveSegments: await archive.deleteOwner(owner)
  };
}

/**
 * 扫描并回收无人认领的归属文件与归档段。
 *
 * `liveTaskIds` 必须是删除动作之后的任务表快照：判定用的是「现在还有没有任务」，
 * 传早了的列表会把正在被删的任务的残留留在盘上（只是少收，不会误删）。
 * 段名与任务 id 的比较走同一个 `contextOwnerSegment`，所以这里不做解码——解码是不可逆的。
 */
export async function reclaimOrphanContextArtifacts(
  store: ContextCheckpointStore,
  archive: ContextArchiveStore,
  liveTaskIds: readonly string[]
): Promise<OrphanCleanupCounts> {
  const live = new Set(liveTaskIds.map(contextOwnerSegment));
  const segments = new Set([
    ...await store.listOwnerSegments('agent-task'),
    ...await archive.listOwnerSegments('agent-task')
  ]);
  let checkpointsRemoved = 0;
  let archiveSegments = 0;
  for (const segment of segments) {
    if (live.has(segment)) continue;
    if (await store.removeOwnerSegment('agent-task', segment)) checkpointsRemoved += 1;
    archiveSegments += await archive.removeOwnerSegment('agent-task', segment);
  }
  return { checkpointsRemoved, archiveSegments };
}
