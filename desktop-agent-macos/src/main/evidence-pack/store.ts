/**
 * Evidence Pack 的冻结存储（Gate 2）。
 *
 * 目录布局（契约 §2.4）：
 *
 *   <dir>/packs/<packId>/manifest.json      ← 提交点
 *   <dir>/packs/<packId>/blobs/<contentHash> ← 内容寻址
 *
 * 发布 = 写临时目录 → 写 manifest 临时文件 → rename manifest → rename 整个目录。
 * manifest 存在且 hash 能验过，才算 ready；中途失败只删临时目录，不发布半成品。
 *
 * 与 `DebateStore` / `VerdictStore` 平级但独立：Pack 要跨辩论复用，不适合塞进
 * 单个辩论 JSON；反过来，旧辩论与旧裁决文件不需要迁移。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_PACK_SCHEMA_VERSION,
  contentHashOf,
  sha256Hex,
  itemHashOf,
  manifestHashOf,
  packIdOf
} from './hash';
import { snapshotFingerprint } from './snapshot';
import {
  EvidencePackError,
  type EvidencePackDeleteResult,
  type EvidencePackDraft,
  type EvidencePackInspection,
  type EvidencePackItem,
  type EvidencePackItemDraft,
  type EvidencePackListEntry,
  type EvidencePackManifest,
  type EvidencePackPublishResult,
  type EvidencePackRead
} from './types';

const PACK_ID_PATTERN = /^pack_[a-f0-9]{16}$/;
const MAX_ITEM_CHARS = 2000;
let tempSeq = 0;

export class EvidencePackStore {
  private readonly packsDir: string;
  private readonly quarantineDir: string;
  /** 同一进程内的读取保护；跨进程仍靠原子 rename 与宽限期。 */
  private readonly activeReads = new Set<string>();

  constructor(private readonly dir: string) {
    this.packsDir = path.join(dir, 'packs');
    this.quarantineDir = path.join(this.packsDir, '.quarantine');
    fs.mkdirSync(this.packsDir, { recursive: true });
    fs.mkdirSync(this.quarantineDir, { recursive: true });
  }

  publish(draft: EvidencePackDraft): EvidencePackPublishResult {
    if (!draft.idempotencyKey) throw new EvidencePackError('INVALID_CONTENT', 'idempotencyKey 不能为空');
    if (!draft.repo.commit) throw new EvidencePackError('INVALID_CONTENT', 'commit 不能为空');

    const packId = packIdOf(draft.idempotencyKey);
    const items = draft.items.map(item => deriveItem(item, draft.repoRoot, draft.repo.commit));

    const seen = new Map<string, EvidencePackItem>();
    for (const item of items) {
      const previous = seen.get(item.itemId);
      if (previous && previous.contentHash !== item.contentHash) {
        throw new EvidencePackError('ITEM_CONFLICT', `同包内 itemId 冲突：${item.itemId}`);
      }
      seen.set(item.itemId, item);
    }

    const manifestHash = manifestHashOf({
      commit: draft.repo.commit,
      itemHashes: items.map(itemHashOf),
      ...(draft.snapshot ? { snapshot: draft.snapshot } : {}),
      ...(draft.context ? { context: draft.context } : {})
    });
    const target = this.packDir(packId);

    if (fs.existsSync(target)) {
      const existing = this.readManifest(packId);
      if (existing.idempotencyKey === draft.idempotencyKey && existing.manifestHash === manifestHash) {
        return { reused: true, manifest: existing };
      }
      throw new EvidencePackError('PACK_CONFLICT', '同一幂等键已有一份内容不同的 Pack，不能覆盖');
    }

    const temp = `${target}.tmp-${process.pid}-${tempSeq++}`;
    try {
      fs.mkdirSync(path.join(temp, 'blobs'), { recursive: true });
      const written = new Set<string>();
      for (const item of items) {
        if (written.has(item.contentHash)) continue;
        written.add(item.contentHash);
        fs.writeFileSync(path.join(temp, 'blobs', item.contentHash), item.content, 'utf8');
      }

      const manifest: EvidencePackManifest = {
        schemaVersion: EVIDENCE_PACK_SCHEMA_VERSION,
        packId,
        status: 'ready',
        idempotencyKey: draft.idempotencyKey,
        repo: {
          commit: draft.repo.commit,
          dirty: Boolean(draft.repo.dirty),
          ...(draft.repo.branch ? { branch: draft.repo.branch } : {})
        },
        items: items.map(({ content: _content, ...rest }) => rest),
        ...(draft.snapshot ? { snapshot: draft.snapshot } : {}),
        ...(draft.context ? { context: draft.context } : {}),
        manifestHash,
        createdAt: draft.createdAt ?? Date.now()
      };

      fs.writeFileSync(path.join(temp, 'manifest.json.tmp'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      fs.renameSync(path.join(temp, 'manifest.json.tmp'), path.join(temp, 'manifest.json'));

      try {
        fs.renameSync(temp, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
        // 另一个调用先发布：只接受同一份内容，否则明确冲突。
        const winner = this.readManifest(packId);
        if (winner.idempotencyKey === draft.idempotencyKey && winner.manifestHash === manifestHash) {
          return { reused: true, manifest: winner };
        }
        throw new EvidencePackError('PACK_CONFLICT', '并发发布：同一幂等键已有不同内容');
      }
      return { reused: false, manifest };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  /** 读不到返回 null；读得到但校验不过抛类型化错误，不给「尽量读出来」的半份结果。 */
  get(packId: string): EvidencePackRead | null {
    this.assertPackId(packId);
    this.activeReads.add(packId);
    try {
      return this.read(packId);
    } finally {
      this.activeReads.delete(packId);
    }
  }

  private read(packId: string): EvidencePackRead | null {
    const manifestFile = this.manifestPath(packId);
    if (!fs.existsSync(manifestFile)) return null;
    const manifest = this.readManifest(packId);

    const expected = manifestHashOf({
      commit: manifest.repo.commit,
      itemHashes: manifest.items.map(itemHashOf),
      ...(manifest.snapshot ? { snapshot: manifest.snapshot } : {}),
      ...(manifest.context ? { context: manifest.context } : {})
    });
    if (expected !== manifest.manifestHash) {
      throw new EvidencePackError('MANIFEST_CORRUPT', 'manifest hash 对不上');
    }

    const items: EvidencePackItem[] = manifest.items.map(item => {
      const blob = path.join(this.packDir(packId), 'blobs', item.contentHash);
      let content: string;
      try {
        content = fs.readFileSync(blob, 'utf8');
      } catch {
        throw new EvidencePackError('BLOB_CORRUPT', `证据内容缺失：${item.itemId}`);
      }
      if (contentHashOf(content) !== item.contentHash) {
        throw new EvidencePackError('BLOB_CORRUPT', `证据内容与 hash 不符：${item.itemId}`);
      }
      return { ...item, content };
    });

    this.verifySnapshot(manifest, items);
    return { manifest, items };
  }

  /** 快照元数据必须与 manifest 条目一致；旧 Pack 没有 snapshot 时跳过。 */
  private verifySnapshot(manifest: EvidencePackManifest, items: readonly EvidencePackItem[]): void {
    if (!manifest.snapshot) return;
    if (manifest.snapshot.dirty) {
      if (!manifest.snapshot.dirtyFingerprint ||
          snapshotFingerprint(manifest.snapshot) !== manifest.snapshot.dirtyFingerprint) {
        throw new EvidencePackError('SNAPSHOT_CORRUPT', 'dirtyFingerprint 与快照元数据不一致');
      }
    }
    const byLocator = new Map(
      items.map(item => [
        `${item.locator.path}\0${String(item.locator.startLine)}\0${String(item.locator.endLine)}`,
        sha256Hex(item.content)
      ])
    );
    for (const file of manifest.snapshot.files) {
      for (const range of file.ranges) {
        const key = `${file.path}\0${String(range.startLine)}\0${String(range.endLine)}`;
        const actual = byLocator.get(key);
        if (!actual || actual !== range.contentHash) {
          throw new EvidencePackError('SNAPSHOT_CORRUPT', `快照范围与条目不一致：${file.path}:${String(range.startLine)}-${String(range.endLine)}`);
        }
      }
    }
  }

  /** 回放入口：与 `get` 同一条校验路径，但找不到 Pack 视为错误而不是 null。 */
  replay(packId: string): EvidencePackRead {
    const pack = this.get(packId);
    if (!pack) throw new EvidencePackError('PACK_NOT_FOUND', '找不到要回放的 Pack');
    return pack;
  }

  /**
   * 轻量扫描：只读 manifest，不加载 Blob。GC 用它建立候选集合；
   * 损坏的 Pack 标 corrupt，不当成「没有引用」。
   */
  list(): EvidencePackListEntry[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.packsDir);
    } catch {
      return [];
    }
    const entries: EvidencePackListEntry[] = [];
    for (const name of names) {
      if (!PACK_ID_PATTERN.test(name)) continue;
      const packId = name;
      try {
        const manifest = this.readManifest(packId);
        entries.push({
          packId,
          status: 'ready',
          createdAt: typeof manifest.createdAt === 'number' ? manifest.createdAt : null,
          commit: manifest.repo?.commit ?? null,
          dirty: typeof manifest.repo?.dirty === 'boolean' ? manifest.repo.dirty : null,
          context: manifest.context ?? null,
          itemCount: manifest.items.length,
          bytes: this.bytesOf(this.packDir(packId))
        });
      } catch (error) {
        entries.push({
          packId,
          status: 'corrupt',
          createdAt: null,
          commit: null,
          dirty: null,
          context: null,
          itemCount: 0,
          bytes: this.bytesOf(this.packDir(packId)),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return entries.sort((a, b) => a.packId.localeCompare(b.packId));
  }

  /** 完整校验一个 Pack；不存在返回 unavailable，损坏返回 corrupt。 */
  inspect(packId: string): EvidencePackInspection {
    this.assertPackId(packId);
    if (!fs.existsSync(this.packDir(packId))) {
      return {
        packId,
        status: 'unavailable',
        createdAt: null,
        commit: null,
        dirty: null,
        context: null,
        itemCount: 0,
        bytes: 0,
        error: 'Pack 不存在'
      };
    }
    try {
      const pack = this.get(packId);
      if (!pack) {
        return {
          packId,
          status: 'unavailable',
          createdAt: null,
          commit: null,
          dirty: null,
          context: null,
          itemCount: 0,
          bytes: this.bytesOf(this.packDir(packId)),
          error: 'manifest 不存在'
        };
      }
      return {
        packId,
        status: 'ready',
        createdAt: pack.manifest.createdAt,
        commit: pack.manifest.repo.commit,
        dirty: pack.manifest.repo.dirty,
        context: pack.manifest.context ?? null,
        itemCount: pack.manifest.items.length,
        bytes: this.bytesOf(this.packDir(packId)),
        manifestHash: pack.manifest.manifestHash,
        schemaVersion: pack.manifest.schemaVersion
      };
    } catch (error) {
      return {
        packId,
        status: 'corrupt',
        createdAt: null,
        commit: null,
        dirty: null,
        context: null,
        itemCount: 0,
        bytes: this.bytesOf(this.packDir(packId)),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 删除一个 Pack：先原子 rename 到 quarantine，再递归删除。
   * 正在被读取的 Pack 不删；引用保护由 GC 层负责。
   */
  delete(packId: string): EvidencePackDeleteResult {
    this.assertPackId(packId);
    if (this.activeReads.has(packId)) {
      return { packId, deleted: false, bytes: 0, reason: 'active-read' };
    }
    const target = this.packDir(packId);
    if (!fs.existsSync(target)) return { packId, deleted: false, bytes: 0, reason: 'not-found' };
    const bytes = this.bytesOf(target);
    fs.mkdirSync(this.quarantineDir, { recursive: true });
    const quarantine = path.join(this.quarantineDir, `${packId}-${process.pid}-${Date.now()}`);
    try {
      fs.renameSync(target, quarantine);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        packId,
        deleted: false,
        bytes: 0,
        reason: code === 'ENOENT' ? 'not-found' : `rename-failed:${String(code)}`
      };
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
    return { packId, deleted: true, bytes };
  }

  /** 发布中断留下的临时目录；GC 只清理超过宽限期的。 */
  listTemporary(): Array<{ name: string; path: string; ageMs: number; bytes: number }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.packsDir);
    } catch {
      return [];
    }
    const now = Date.now();
    return names
      .filter(name => /^pack_[a-f0-9]{16}\.tmp-/.test(name))
      .flatMap(name => {
        try {
          const absolute = path.join(this.packsDir, name);
          const stat = fs.statSync(absolute);
          return [{ name, path: absolute, ageMs: Math.max(0, now - stat.mtimeMs), bytes: this.bytesOf(absolute) }];
        } catch {
          return [];
        }
      });
  }

  /** 上次 GC 崩溃留下的 quarantine 目录。 */
  listQuarantine(): Array<{ name: string; path: string; ageMs: number; bytes: number }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.quarantineDir);
    } catch {
      return [];
    }
    const now = Date.now();
    return names.flatMap(name => {
      try {
        const absolute = path.join(this.quarantineDir, name);
        const stat = fs.statSync(absolute);
        return [{ name, path: absolute, ageMs: Math.max(0, now - stat.mtimeMs), bytes: this.bytesOf(absolute) }];
      } catch {
        return [];
      }
    });
  }

  private bytesOf(target: string): number {
    let total = 0;
    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) return stat.size;
      for (const name of fs.readdirSync(target)) total += this.bytesOf(path.join(target, name));
    } catch {
      return total;
    }
    return total;
  }

  private readManifest(packId: string): EvidencePackManifest {
    const file = this.manifestPath(packId);
    let manifest: EvidencePackManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as EvidencePackManifest;
    } catch {
      throw new EvidencePackError('MANIFEST_CORRUPT', 'manifest 读不出来或不是 JSON');
    }
    if (!manifest || typeof manifest !== 'object') {
      throw new EvidencePackError('MANIFEST_CORRUPT', 'manifest 结构不对');
    }
    if (manifest.schemaVersion !== EVIDENCE_PACK_SCHEMA_VERSION) {
      throw new EvidencePackError(
        'UNSUPPORTED_VERSION',
        `不支持的 Pack 版本：${String(manifest.schemaVersion)}`
      );
    }
    if (manifest.packId !== packId || !Array.isArray(manifest.items) || !manifest.repo?.commit) {
      throw new EvidencePackError('MANIFEST_CORRUPT', 'manifest 字段不完整或 packId 不一致');
    }
    return manifest;
  }

  private assertPackId(packId: string): void {
    if (!PACK_ID_PATTERN.test(packId)) throw new EvidencePackError('INVALID_PACK_ID', '无效的 Pack id');
  }

  private packDir(packId: string): string {
    this.assertPackId(packId);
    return path.join(this.packsDir, packId);
  }

  private manifestPath(packId: string): string {
    return path.join(this.packDir(packId), 'manifest.json');
  }
}

/** 把一条草稿变成冻结条目：定位、行号、内容、hash 都在这里定死。 */
function deriveItem(draft: EvidencePackItemDraft, repoRoot: string, commit: string): EvidencePackItem {
  const relPath = normalizeRelativePath(draft.locator.path);
  if (draft.source.commit !== commit) {
    throw new EvidencePackError('INVALID_CONTENT', '条目 commit 与 Pack 的 commit 不一致');
  }

  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, relPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new EvidencePackError('INVALID_PATH', `路径越出仓库：${draft.locator.path}`);
  }

  const { startLine, endLine } = draft.locator;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new EvidencePackError('INVALID_RANGE', `startLine 必须从 1 开始：${String(startLine)}`);
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new EvidencePackError('INVALID_RANGE', `endLine 必须 >= startLine：${String(endLine)}`);
  }

  let content: string;
  if (draft.content !== undefined) {
    // 调用方已经冻结了内容：校验行数与长度，不再重读文件。
    content = draft.content;
    const lines = content.split('\n');
    if (lines.length !== endLine - startLine + 1) {
      throw new EvidencePackError('INVALID_RANGE', `冻结内容行数与 locator 不一致：${relPath}:${startLine}-${endLine}`);
    }
  } else {
    let source: string;
    try {
      source = fs.readFileSync(absolute, 'utf8');
    } catch {
      throw new EvidencePackError('INVALID_PATH', `读不到证据文件：${relPath}`);
    }
    const lines = source.split(/\r?\n/);
    if (endLine > lines.length) {
      throw new EvidencePackError('INVALID_RANGE', `endLine ${String(endLine)} 超过文件行数 ${String(lines.length)}`);
    }
    content = lines.slice(startLine - 1, endLine).join('\n');
  }
  if (content.length === 0) throw new EvidencePackError('INVALID_CONTENT', '证据片段不能为空');
  if (content.length > MAX_ITEM_CHARS) {
    throw new EvidencePackError(
      'INVALID_CONTENT',
      `单条证据 ${String(content.length)} 字符，超过上限 ${String(MAX_ITEM_CHARS)}；应拆分而不是截断`
    );
  }

  if (draft.attestation) {
    if (draft.kind !== 'test-result' && draft.kind !== 'command-result') {
      throw new EvidencePackError('INVALID_CONTENT', 'attestation 只能用于 test-result / command-result');
    }
    const attestation = draft.attestation;
    if (attestation.repoCommit !== commit) {
      throw new EvidencePackError('INVALID_CONTENT', 'attestation 的 repoCommit 与 Pack 不一致');
    }
    if (!attestation.executionId || !attestation.assertionId || !attestation.claimId) {
      throw new EvidencePackError('INVALID_CONTENT', 'attestation 缺少 executionId/assertionId/claimId');
    }
    if (!/^[a-f0-9]{64}$/.test(attestation.resultHash)) {
      throw new EvidencePackError('INVALID_CONTENT', 'attestation.resultHash 必须是 sha256 hex');
    }
    if (attestation.assertion === 'passed' && attestation.exitCode !== undefined && attestation.exitCode !== 0) {
      throw new EvidencePackError('INVALID_CONTENT', 'passed 断言的 exitCode 必须为 0');
    }
    if (!attestation.producer?.name || !attestation.producer?.version) {
      throw new EvidencePackError('INVALID_CONTENT', 'attestation 缺少 producer 名称/版本');
    }
  }

  return {
    itemId: `item_${sha256Hex(
      [draft.kind, relPath, startLine, endLine, draft.locator.symbolId ?? ''].join('\0')
    ).slice(0, 16)}`,
    kind: draft.kind,
    ...(draft.attestation ? { attestation: draft.attestation } : {}),
    source: {
      commit,
      path: relPath,
      ...(draft.source.language ? { language: draft.source.language } : {})
    },
    locator: {
      path: relPath,
      startLine,
      endLine,
      ...(draft.locator.symbolId ? { symbolId: draft.locator.symbolId } : {}),
      ...(draft.locator.symbolName ? { symbolName: draft.locator.symbolName } : {})
    },
    content,
    contentHash: contentHashOf(content),
    meta: { ...draft.meta }
  };
}

function normalizeRelativePath(input: string): string {
  if (!input) throw new EvidencePackError('INVALID_PATH', '路径不能为空');
  if (path.isAbsolute(input)) throw new EvidencePackError('INVALID_PATH', `必须是仓库相对路径：${input}`);
  if (input.includes('\\')) throw new EvidencePackError('INVALID_PATH', `路径不能含反斜杠：${input}`);
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized.startsWith('..')) {
    throw new EvidencePackError('INVALID_PATH', `路径不能越出仓库：${input}`);
  }
  return normalized;
}
