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
  itemHashOf,
  manifestHashOf,
  packIdOf,
  sha256Hex
} from './hash';
import {
  EvidencePackError,
  type EvidencePackDraft,
  type EvidencePackItem,
  type EvidencePackItemDraft,
  type EvidencePackManifest,
  type EvidencePackPublishResult,
  type EvidencePackRead
} from './types';

const PACK_ID_PATTERN = /^pack_[a-f0-9]{16}$/;
const MAX_ITEM_CHARS = 2000;
let tempSeq = 0;

export class EvidencePackStore {
  private readonly packsDir: string;

  constructor(private readonly dir: string) {
    this.packsDir = path.join(dir, 'packs');
    fs.mkdirSync(this.packsDir, { recursive: true });
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
      itemHashes: items.map(itemHashOf)
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
    const manifestFile = this.manifestPath(packId);
    if (!fs.existsSync(manifestFile)) return null;
    const manifest = this.readManifest(packId);

    const expected = manifestHashOf({
      commit: manifest.repo.commit,
      itemHashes: manifest.items.map(itemHashOf)
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

    return { manifest, items };
  }

  /** 回放入口：与 `get` 同一条校验路径，但找不到 Pack 视为错误而不是 null。 */
  replay(packId: string): EvidencePackRead {
    const pack = this.get(packId);
    if (!pack) throw new EvidencePackError('PACK_NOT_FOUND', '找不到要回放的 Pack');
    return pack;
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

  let source: string;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    throw new EvidencePackError('INVALID_PATH', `读不到证据文件：${relPath}`);
  }
  const lines = source.split(/\r?\n/);
  const { startLine, endLine } = draft.locator;
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new EvidencePackError('INVALID_RANGE', `startLine 必须从 1 开始：${String(startLine)}`);
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new EvidencePackError('INVALID_RANGE', `endLine 必须 >= startLine：${String(endLine)}`);
  }
  if (endLine > lines.length) {
    throw new EvidencePackError('INVALID_RANGE', `endLine ${String(endLine)} 超过文件行数 ${String(lines.length)}`);
  }

  const content = lines.slice(startLine - 1, endLine).join('\n');
  if (content.length === 0) throw new EvidencePackError('INVALID_CONTENT', '证据片段不能为空');
  if (content.length > MAX_ITEM_CHARS) {
    throw new EvidencePackError(
      'INVALID_CONTENT',
      `单条证据 ${String(content.length)} 字符，超过上限 ${String(MAX_ITEM_CHARS)}；应拆分而不是截断`
    );
  }

  return {
    itemId: `item_${sha256Hex(
      [draft.kind, relPath, startLine, endLine, draft.locator.symbolId ?? ''].join('\0')
    ).slice(0, 16)}`,
    kind: draft.kind,
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
