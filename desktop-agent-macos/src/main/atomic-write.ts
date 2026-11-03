import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file so that a reader sees either the old contents or the new ones.
 *
 * `writeFileSync(file, …)` opens with `O_TRUNC`: the bytes on disk are gone
 * before the new ones arrive. A crash, a force quit, or a full disk in that
 * window leaves a truncated file — and for a settings file that is worse than
 * it sounds, because the loader cannot parse half a JSON object. It falls back
 * to the shipped defaults, so every edit the person ever made disappears at the
 * next launch, silently, at the one moment when nothing can be done about it.
 *
 * So: write a sibling temp file, flush it, then `rename` it over the target.
 * Rename inside one directory is atomic, which makes the swap invisible to
 * anyone reading the file. The temp name carries the pid so a dev build and a
 * packaged build cannot collide on it.
 *
 * Errors are thrown, not swallowed. A caller that cannot write has to say so
 * while the person is still looking at the button they pressed.
 */
export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let handle: number | null = null;
  try {
    handle = fs.openSync(tmp, 'w', mode);
    fs.writeFileSync(handle, contents);
    // Without the flush the rename can land while the bytes are still in the
    // page cache. That is a fine trade for a cache and a bad one for a setting.
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, file);
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        /* already gone; the original error is the one worth reporting */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* a leftover temp file is harmless: nothing reads it */
    }
    throw error;
  }
}

/** The last known-good copy that `writeFileAtomic` callers keep beside the file. */
export function backupPath(file: string): string {
  return `${file}.bak`;
}
