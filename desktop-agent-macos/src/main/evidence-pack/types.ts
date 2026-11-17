/**
 * Evidence Pack 契约（Gate 1 / Gate 2）。
 *
 * 它不是第二套证据数据库，而是「辩论证据的可追溯快照」：
 * - 内容冻结在 Pack 里，仓库后来怎么改都不影响旧 Pack；
 * - 主张与证据的关系仍由 `ClaimEvidenceLink` 表达，不塞进 Pack；
 * - 映射层负责把条目变成辩论系统能消费的 `DebateEvidence`。
 *
 * 刻意不扩展 `EvidenceKind`：它已经被综合层和界面使用，直接加工程类型会
 * 改变旧数据的语义。工程证据的类型走 `EvidencePackItemKind`，到映射层再收敛。
 */

export type EvidencePackItemKind =
  | 'source-file'
  | 'symbol'
  | 'call-edge'
  | 'test-result'
  | 'command-result'
  | 'dependency'
  | 'git-commit'
  | 'doc-excerpt';

export interface EvidencePackItemSource {
  /** 快照对应的 commit；不是采集时刻的「最新」。 */
  commit: string;
  /** 仓库相对路径；只有 `path` 参与定位，绝对路径一律拒绝。 */
  path?: string;
  language?: string;
}

export interface EvidencePackItemLocator {
  path: string;
  /** 从 1 开始；越界直接失败，不截断成空证据。 */
  startLine: number;
  endLine: number;
  /** 复用 code-index 的稳定 id；没有就不写。 */
  symbolId?: string;
  symbolName?: string;
}

export interface EvidencePackSnapshotRange {
  startLine: number;
  endLine: number;
  /** 片段原始 UTF-8 内容的 sha256，不是 Pack blob hash。 */
  contentHash: string;
}

export interface EvidencePackSnapshotIssue {
  code: string;
  path?: string;
  message: string;
}

export interface EvidencePackSnapshotFile {
  path: string;
  ranges: EvidencePackSnapshotRange[];
  issues: EvidencePackSnapshotIssue[];
}

export interface EvidencePackSnapshot {
  version: 1;
  dirty: boolean;
  dirtyFingerprint?: string;
  files: EvidencePackSnapshotFile[];
  /** 无法冻结的文件/全局错误；不能只拼成一句 reason。 */
  errors: EvidencePackSnapshotIssue[];
}

export interface EvidencePackContext {
  kind: 'baseline' | 'round';
  debateId: string;
  roundIndex?: number;
  baselinePackId?: string;
}

export interface EvidencePackItemMeta {
  tool: string;
  /** 不参与 hash：同一条证据换一次采集时间，仍然算同一份内容。 */
  capturedAt: number;
  generation?: number;
  /** 这条条目在快照里的角色；不参与 hash，只供人读。 */
  snapshotRole?: 'dirty-overlay' | 'round';
  command?: string;
  exitCode?: number;
  /** `doc-excerpt` 必须显式给出，否则映射层拒绝猜来源类型。 */
  sourceType?: 'official-doc' | 'paper' | 'blog';
}

export interface EvidencePackItemDraft {
  kind: EvidencePackItemKind;
  /**
   * 已经冻结好的内容。给 baseline/dirty overlay 用：避免「解析时读到的是 A，
   * 发布时又重读成 B」。不传时 Store 从 repoRoot 读文件。
   */
  content?: string;
  source: EvidencePackItemSource;
  locator: EvidencePackItemLocator;
  meta: EvidencePackItemMeta;
}

export interface EvidencePackItem {
  itemId: string;
  kind: EvidencePackItemKind;
  source: EvidencePackItemSource;
  locator: EvidencePackItemLocator;
  /** 冻结原文，不改写、不省略。 */
  content: string;
  contentHash: string;
  meta: EvidencePackItemMeta;
}

/** 落盘时内容进 blobs，manifest 只留元数据。 */
export type EvidencePackManifestItem = Omit<EvidencePackItem, 'content'>;

export interface EvidencePackManifest {
  schemaVersion: 1;
  packId: string;
  status: 'ready';
  idempotencyKey: string;
  repo: { commit: string; dirty: boolean; branch?: string };
  items: EvidencePackManifestItem[];
  /** 结构化 dirty overlay 元数据；旧 Schema v1 Pack 没有。 */
  snapshot?: EvidencePackSnapshot;
  /** Pack 属于哪场辩论/哪一轮；旧 Pack 没有。 */
  context?: EvidencePackContext;
  manifestHash: string;
  createdAt: number;
}

export interface EvidencePackDraft {
  /** 只用于读源码，不写入 manifest。 */
  repoRoot: string;
  /** 结构化快照元数据；旧 Pack 没有这个字段。 */
  snapshot?: EvidencePackSnapshot;
  /** Pack 属于哪场辩论/哪一轮；旧 Pack 没有。 */
  context?: EvidencePackContext;
  idempotencyKey: string;
  repo: { commit: string; dirty?: boolean; branch?: string };
  createdAt?: number;
  items: EvidencePackItemDraft[];
}

export interface EvidencePackRead {
  manifest: EvidencePackManifest;
  items: EvidencePackItem[];
}

export interface EvidencePackPublishResult {
  /** true = 同键同内容，返回已有 Pack；false = 本次新发布。 */
  reused: boolean;
  manifest: EvidencePackManifest;
}

export type EvidencePackErrorCode =
  | 'INVALID_PACK_ID'
  | 'PACK_NOT_FOUND'
  | 'INVALID_PATH'
  | 'INVALID_RANGE'
  | 'INVALID_CONTENT'
  | 'ITEM_CONFLICT'
  | 'PACK_CONFLICT'
  | 'UNSUPPORTED_VERSION'
  | 'MANIFEST_CORRUPT'
  | 'BLOB_CORRUPT'
  | 'SNAPSHOT_CORRUPT'
  | 'UNMAPPED_ITEM';

export class EvidencePackError extends Error {
  constructor(
    readonly code: EvidencePackErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EvidencePackError';
  }
}
