/**
 * 同一进程内的文件写锁。
 *
 * 只覆盖本应用这一侧：多个步骤/Agent 同时改一个文件时，后来者排队，
 * 不会出现「A 读到旧内容、B 写新内容、A 再把 B 的改动盖掉」。
 *
 * 不假装是跨进程锁：别的编辑器、别的进程不经过这里。真正防跨进程覆盖的
 * 是 `expectedHash`——读到的版本变了就拒绝，而不是等锁。
 */

const tails = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const previous = tails.get(file) ?? Promise.resolve();
  const current = previous.then(run, run);
  // 队尾只用于排队；一个任务失败不能卡住后面所有等待者。
  const tail = current.catch(() => undefined);
  tails.set(file, tail);
  try {
    return await current;
  } finally {
    if (tails.get(file) === tail) tails.delete(file);
  }
}
