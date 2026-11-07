/**
 * 工作空间的全局默认值，落在 `userData/workspace-state.json`。
 *
 * 会话自己也存一份 `workspaceMode` / `workspaceRoot`（打开老会话时要读回来），
 * 这份文件管的是「新开一条会话时用哪个空间、哪个项目」。两者缺一不可：
 * 只有全局，点开一条历史知识会话会被当前工程空间带跑；只有会话级，
 * 每次重开应用都要重新选一遍项目——窗口大小那次就是这个教训。
 *
 * 写入走原子替换；坏文件直接退回默认值，不猜半个 JSON。
 */

import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write';
import {
  DEFAULT_WORKSPACE_STATE,
  normalizeWorkspaceState,
  type WorkspaceState
} from '../shared/workspace';

export class WorkspaceStore {
  private state: WorkspaceState = { ...DEFAULT_WORKSPACE_STATE };

  constructor(private readonly file: string) {
    try {
      this.state = normalizeWorkspaceState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      this.state = { ...DEFAULT_WORKSPACE_STATE };
    }
  }

  get(): WorkspaceState {
    return { ...this.state };
  }

  set(patch: Partial<WorkspaceState>): WorkspaceState {
    this.state = normalizeWorkspaceState({ ...this.state, ...patch });
    writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
    return this.get();
  }
}
