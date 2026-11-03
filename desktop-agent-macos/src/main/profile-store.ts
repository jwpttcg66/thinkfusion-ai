import fs from 'node:fs';
import { writeFileAtomic } from './atomic-write';
import { DEFAULT_DISPLAY_NAME, normalizeDisplayName } from '../shared/identity';

interface ProfileFile {
  /** Absent means "never renamed" — the default applies, it is not written out. */
  displayName?: string;
}

/**
 * The display name, and nothing else.
 *
 * Deliberately not folded into `sources.json`: that file is a delta over shipped
 * defaults, and a rename has nothing to do with which pages exist. A corrupt
 * profile is dropped rather than repaired — the worst case is a person's chosen
 * name reverting to 本机用户, which is recoverable in one click, whereas guessing
 * at half-parsed JSON is not.
 */
export class ProfileStore {
  private state: ProfileFile = {};

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ProfileFile;
      const check = normalizeDisplayName(parsed?.displayName);
      // Anything that does not pass today's rules is simply not a name.
      if (check.ok && check.name) this.state = { displayName: check.name };
    } catch {
      /* missing or corrupt: keep the default */
    }
  }

  private persist() {
    // Same atomic swap as the sources file: a name that survives to the next
    // launch is the only thing 「保存」 can mean.
    writeFileAtomic(this.file, JSON.stringify(this.state));
  }

  displayName(): string {
    return this.state.displayName ?? DEFAULT_DISPLAY_NAME;
  }

  /** Throws with a sentence the settings panel can show as-is. */
  setDisplayName(raw: unknown): string {
    const check = normalizeDisplayName(raw);
    if (!check.ok || !check.name) throw new Error(check.error ?? '这个名字不能用');
    this.state = { displayName: check.name };
    this.persist();
    return check.name;
  }

  /** Back to the shipped name — the 「恢复默认」 button. */
  reset(): string {
    this.state = {};
    this.persist();
    return DEFAULT_DISPLAY_NAME;
  }
}
