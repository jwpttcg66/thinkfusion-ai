/**
 * 每个任务的外部 Agent 工作树。
 *
 * 为什么不是「让 CLI 直接改主工作区」：它自带工具循环，取消时可能改到一半；
 * 直接写主树会让「取消」变成「留下半成品」，也让多 Agent 无法各自实现。
 * 所以带 agent.exec 的计划在审批时创建一个独立 git worktree，CLI 只在那里面跑。
 *
 * 三个刻意的边界：
 *
 * - 工作树位置在应用数据目录，不在仓库里；不会污染 `git status`。
 * - 取消/失败默认保留工作树，不自动回滚——回滚别人的半成品比保留更危险。
 * - 合并是显式动作：先在工作树里提交，再由用户点合并；冲突会自动 abort，
 *   不让主仓库停在半合并状态。
 */

export interface TaskWorktreeView {
  taskId: string;
  /** 审批时的任务工作区（主仓库目录）。 */
  rootDir: string;
  /** 独立工作树目录。 */
  dir: string;
  /** 例：tf/task-abc123。 */
  branch: string;
  /** 创建时的分支名；detached HEAD 时是 HEAD。 */
  baseBranch: string;
  baseCommit: string;
  createdAt: number;
  exists: boolean;
  /** 有未提交改动（含未跟踪文件）。 */
  dirty: boolean;
  changedFiles: string[];
  /** 相对基线的提交数。 */
  ahead: number;
  /** 分支是否已经进主仓库当前 HEAD。 */
  merged: boolean;
}

export interface TaskWorktreeDiff {
  dir: string;
  branch: string;
  /** 已跟踪文件的 diff（含已暂存与未暂存）。 */
  diff: string;
  /** 未跟踪文件只列名字：不替用户把它们的全文塞进界面。 */
  untracked: string[];
  truncated: boolean;
}

export interface TaskWorktreeCommitInput {
  taskId: string;
  message: string;
}

export interface TaskWorktreeRemoveInput {
  taskId: string;
  /** 有未提交改动时，只有显式 force 才删。 */
  force?: boolean;
}

export interface TaskWorktreeMergeResult {
  taskId: string;
  branch: string;
  /** 合并后的 HEAD。 */
  commit: string;
  message: string;
}
