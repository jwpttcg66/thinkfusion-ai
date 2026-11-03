import fs from 'node:fs';
import {
  BUILTIN_SOURCES,
  EMPTY_STORED_SOURCES,
  normalizeSourceUrl,
  type PageSource,
  type SourceOverride,
  type StoredSources
} from '../shared/sources';
import { backupPath, writeFileAtomic } from './atomic-write';

/**
 * The user's source settings, on disk.
 *
 * Reads are lenient: a corrupt file must not stop the app from starting. Writes
 * are the opposite — they are the whole promise of the 保存 button, so a write
 * that cannot land says so instead of failing quietly. (It used to be best
 * effort: the panel said 保存, the disk said nothing, and the loss only surfaced
 * at the next launch, which is the one moment too late to do anything.)
 *
 * Only *deltas* are stored, never the resolved list. Storing the resolved list
 * would freeze today's defaults into the user's file, and then a future release
 * that fixes a URL, adds a source or renames one would be invisible to everyone
 * who ever pressed 保存 once.
 */
export class SourceStore {
  private data: StoredSources = { ...EMPTY_STORED_SOURCES };
  /** Set when the main file was unreadable and the backup answered instead. */
  private recoveredFromBackup = false;

  constructor(private readonly file: string) {
    this.load();
  }

  /**
   * Read the file, and if it cannot be read, read the copy beside it.
   *
   * The backup is not version history — it exists for one failure: a file that
   * arrived damaged from outside (a disk error, a stray editor, a half-restored
   * backup). Handing back the shipped defaults in that case would look exactly
   * like "the app forgot everything", which is the complaint this class is
   * supposed to prevent.
   */
  private load() {
    for (const [file, isBackup] of [
      [this.file, false],
      [backupPath(this.file), true]
    ] as const) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const record = parsed as Partial<StoredSources>;
        this.data = {
          overrides: sanitizeOverrides(record.overrides),
          custom: sanitizeCustom(record.custom)
        };
        this.recoveredFromBackup = isBackup;
        return;
      } catch {
        /* missing or unreadable: try the next candidate */
      }
    }
    this.data = { overrides: {}, custom: [] };
  }

  /**
   * Replace the file, atomically, keeping one known-good copy beside it.
   *
   * `previous` is the state from before the edit: if the write fails, memory
   * goes back to it, because a row that renders as saved while the disk refused
   * it is the exact lie this method exists to stop telling.
   */
  private persist(previous: StoredSources) {
    const bak = backupPath(this.file);
    try {
      // Copy the file that is about to be replaced, so a file damaged from
      // outside always has a good predecessor to fall back to. Skipped after a
      // fallback: there the main file *is* the damaged one, and copying it over
      // the good copy would destroy the only thing that still has the settings.
      if (!this.recoveredFromBackup) {
        try {
          fs.copyFileSync(this.file, bak);
        } catch {
          /* nothing to copy yet */
        }
      }
      writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
      // The first save has no predecessor, so it becomes its own fallback.
      // Without this the guarantee would only start on the second save, and the
      // first one — the one where someone just typed an address — would be the
      // unprotected one.
      if (!fs.existsSync(bak)) {
        try {
          fs.copyFileSync(this.file, bak);
        } catch {
          /* a missing fallback is not a failed save */
        }
      }
    } catch (error) {
      this.data = previous;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`设置没能写到磁盘上，重启后会丢：${reason}`);
    }
  }

  all(): StoredSources {
    return { overrides: { ...this.data.overrides }, custom: [...this.data.custom] };
  }

  /**
   * Record an edit for one source.
   *
   * A key that is *absent* means "leave it alone"; a key that is present and
   * `undefined` means "back to the shipped value". The difference matters
   * because the settings panel always sends a whole row, so without it there
   * would be no way to express a reset — and an override that says nothing is
   * not the same as no override.
   */
  patch(id: string, override: SourceOverride): StoredSources {
    const previous = this.all();
    const next: SourceOverride = { ...this.data.overrides[id] };
    if ('url' in override) {
      if (override.url === undefined) delete next.url;
      else next.url = override.url;
    }
    if ('enabled' in override) {
      if (override.enabled === undefined) delete next.enabled;
      else next.enabled = override.enabled;
    }
    const overrides = { ...this.data.overrides };
    if (Object.keys(next).length === 0) delete overrides[id];
    else overrides[id] = next;
    this.data = { ...this.data, overrides };
    this.persist(previous);
    return this.all();
  }

  addCustom(source: PageSource): StoredSources {
    const previous = this.all();
    this.data = { ...this.data, custom: [...this.data.custom, source] };
    this.persist(previous);
    return this.all();
  }

  removeCustom(id: string): StoredSources {
    const previous = this.all();
    const overrides = { ...this.data.overrides };
    delete overrides[id];
    this.data = { custom: this.data.custom.filter(source => source.id !== id), overrides };
    this.persist(previous);
    return this.all();
  }
}

/** Keep only the fields that mean something, and only for known sources. */
function sanitizeOverrides(raw: unknown): Record<string, SourceOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, SourceOverride> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const override: SourceOverride = {};
    if (typeof entry.url === 'string') {
      // A stored URL that cannot be normalized is dropped, not carried forward:
      // it would fail the allow-list on every navigation and look like a
      // network problem.
      const check = normalizeSourceUrl(entry.url);
      if (check.ok && check.url) override.url = check.url;
    }
    if (typeof entry.enabled === 'boolean') override.enabled = entry.enabled;
    if (Object.keys(override).length > 0) out[id] = override;
  }
  return out;
}

/**
 * Custom sources are re-validated on load.
 *
 * An id that collides with a built-in would make two rail buttons point at one
 * view, and a URL that no longer normalizes would leave a source that can never
 * load. Both are dropped rather than repaired, because a repaired one would be
 * a different source than the one that was saved.
 */
function sanitizeCustom(raw: unknown): PageSource[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set(BUILTIN_SOURCES.map(source => source.id));
  const out: PageSource[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const url = typeof entry.url === 'string' ? normalizeSourceUrl(entry.url) : { ok: false };
    if (!id || !label || !url.ok || !url.url || taken.has(id)) continue;
    taken.add(id);
    out.push({
      id,
      label: label.slice(0, 24),
      glyph: typeof entry.glyph === 'string' && entry.glyph ? entry.glyph[0] : (label[0] ?? '?').toUpperCase(),
      url: url.url,
      hosts: Array.isArray(entry.hosts) ? entry.hosts.filter((host): host is string => typeof host === 'string') : [],
      planning: false,
      enabled: entry.enabled !== false,
      custom: true
    });
  }
  return out;
}
