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
  writeBufferAtomic(file, Buffer.from(contents, 'utf8'), mode);
}

/**
 * 二进制版本。导出的 docx 是 zip，按字符串写会被 UTF-8 编一遍，文件就打不开了。
 *
 * 和上面同一个道理：先写同目录临时文件、fsync、rename，读者要么看到旧文件、
 * 要么看到完整的新文件，不会看到写了一半的导出。
 */
export function writeBufferAtomic(file: string, contents: Buffer, mode = 0o644): void {
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
    try {
      fs.renameSync(tmp, file);
    } catch (renameError) {
      /**
       * 有些目录不允许 rename 覆盖（macOS 的受管目录、跨卷挂载、加壳应用的
       * 容器都会返回 EPERM / EACCES / EXDEV）。这时**直接写目标文件**：
       * 换来的代价是「写到一半断电可能留下半个文件」，换掉的是「设置永远
       * 存不上」——后者在真机上就是每次点保存都弹红字，而且无从自救。
       *
       * 其它错误照旧抛出：磁盘满、路径不存在之类的信息不该被这层吞掉。
       */
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EXDEV') throw renameError;
      fs.writeFileSync(file, contents, { mode });
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 临时文件留着也无害，没人读它 */
      }
    }
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
