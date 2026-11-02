import fs from 'node:fs';
import path from 'node:path';
import {
  BUILTIN_SOURCES,
  EMPTY_STORED_SOURCES,
  normalizeSourceUrl,
  type PageSource,
  type SourceOverride,
  type StoredSources
} from '../shared/sources';

/**
 * The user's source settings, on disk.
 *
 * Same posture as `SelectorStore`: reads are lenient (a corrupt file must not
 * stop the app from starting — the worst case is that the shipped defaults come
 * back), writes are best-effort (a read-only profile directory degrades to
 * "your edits last until you quit", not to a crash).
 *
 * Only *deltas* are stored, never the resolved list. Storing the resolved list
 * would freeze today's defaults into the user's file, and then a future release
 * that fixes a URL, adds a source or renames one would be invisible to everyone
 * who ever pressed 保存 once.
 */
export class SourceStore {
  private data: StoredSources = { ...EMPTY_STORED_SOURCES };

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const record = parsed as Partial<StoredSources>;
      this.data = {
        overrides: sanitizeOverrides(record.overrides),
        custom: sanitizeCustom(record.custom)
      };
    } catch {
      this.data = { overrides: {}, custom: [] };
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* best effort: see the class comment */
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
    this.persist();
    return this.all();
  }

  addCustom(source: PageSource): StoredSources {
    this.data = { ...this.data, custom: [...this.data.custom, source] };
    this.persist();
    return this.all();
  }

  removeCustom(id: string): StoredSources {
    const overrides = { ...this.data.overrides };
    delete overrides[id];
    this.data = { custom: this.data.custom.filter(source => source.id !== id), overrides };
    this.persist();
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
