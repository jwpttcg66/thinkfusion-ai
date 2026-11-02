import fs from 'node:fs';
import path from 'node:path';
import { SELECTOR_ROLES, type SelectorProfile, type SelectorRole } from '../shared/selectors';

/**
 * Selectors learned from a page, remembered per source and per host.
 *
 * Per host, not per source, because a source is not a site: the ChatGPT view
 * sits on `chatgpt.com` normally and on `auth.openai.com` while signing in, and
 * a selector learned on the login page would be nonsense on the chat page. A
 * stored entry that does not match the host the page is actually on is ignored
 * rather than applied to whatever happens to be loaded.
 */
export interface LearnedEntry {
  host: string;
  roles: Partial<Record<SelectorRole, string[]>>;
  learnedAt: number;
}

export type LearnedFile = Record<string, LearnedEntry>;

/**
 * Fold learned selectors into a built-in profile.
 *
 * Appended, never prepended. The built-in list is a set of promises about a
 * site the author has seen; a learned list is a guess about a site that changed
 * under us. If a built-in selector still matches, it must win — otherwise a
 * stale learned value (a redesign that has since been redesigned back) would
 * quietly redirect a page that was working, and the repair would become the bug.
 */
export function mergeProfile(
  base: SelectorProfile,
  learned: Partial<Record<SelectorRole, string[]>> | undefined
): SelectorProfile {
  if (!learned) return base;
  const merged = { ...base } as SelectorProfile;
  for (const role of SELECTOR_ROLES) {
    const extra = learned[role];
    if (!extra || extra.length === 0) continue;
    const additions = extra.filter(item => item.length > 0 && !base[role].includes(item));
    if (additions.length === 0) continue;
    merged[role] = [...base[role], ...additions];
  }
  return merged;
}

/**
 * The learned-selector file.
 *
 * Reads are lenient on purpose: a corrupt file must not stop the app from
 * starting, and the worst case of losing it is one press of 「更新样式」. Writes
 * are best-effort for the same reason — a read-only profile directory should
 * degrade to "learning lasts until you quit", not to a crash.
 */
export class SelectorStore {
  private data: LearnedFile = {};

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as LearnedFile;
      }
    } catch {
      this.data = {};
    }
  }

  /** Learned roles for this source, but only if the page is still on that host. */
  forHost(sourceId: string, host: string): Partial<Record<SelectorRole, string[]>> | undefined {
    const entry = this.data[sourceId];
    if (!entry || entry.host !== host) return undefined;
    return entry.roles;
  }

  save(sourceId: string, host: string, roles: Partial<Record<SelectorRole, string[]>>): void {
    this.data[sourceId] = { host, roles, learnedAt: Date.now() };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* best effort: see the class comment */
    }
  }

  clear(sourceId: string): void {
    delete this.data[sourceId];
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* best effort */
    }
  }

  /** For diagnostics: what has been learned, without exposing the file path. */
  snapshot(): LearnedFile {
    return JSON.parse(JSON.stringify(this.data)) as LearnedFile;
  }
}
