/**
 * 「这一步到底有没有在做检查」的唯一口径。
 *
 * 三处要用同一份判断：执行后的验证闸门（`agent/verification.ts`）、计划门禁
 * （`main/engineering/plan-review.ts:checkPlanCapabilities`）、方案评审的辩题
 * （`planDebateTopics`）。以前三处各写一遍「有没有 test.run」，于是模型直接写
 * `javac … && out=$(java …) && [ "$out" = "hello jwp" ]` 这种真编译、真运行、
 * 真断言的命令时：闸门判「没有成功的测试或诊断」，评审还每次都追着问「为什么
 * 没有 test.run」。工具名不是证据，跑过什么才是证据。
 *
 * 这里只回答「命令本身做没做检查」，不规定该用哪个工具——用 javac、mvn、pytest
 * 还是 npm test，由模型按任务自己设计。
 */

export type EvidenceKind = 'compile' | 'tests';

/** 与 `test.run` 的老口径保持一致：命令里带 typecheck / build 就算编译。 */
export const COMPILE_COMMAND = /typecheck|build/i;

const SHELL_TEST =
  /(?:\bnpm\s+(?:run\s+)?test\b|\byarn\s+test\b|\bpnpm\s+test\b|\bnode\s+--test\b|\bmvn\b[^&|;]*?\b(?:test|verify)\b|\bgradlew?\b[^&|;]*?\btest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bvitest\b|\brspec\b|\bphpunit\b|\bctest\b)/;
const SHELL_BUILD =
  /(?:\bjavac\b|\bmvn\b|\bgradlew?\b|\btsc\b|\bcmake\b|\bdotnet\s+build\b|\bgo\s+build\b|\bcargo\s+(?:build|check)\b|\bnpm\s+run\s+(?:build|compile)\b|\byarn\s+build\b|\bvite\s+build\b|\bwebpack\b)/;
/** `make` 只认命令开头，避免把 `echo 'make sure'` 当成构建过。 */
const SHELL_MAKE = /(?:^|[;&|(]\s*)make\b/;
/** `[ "$out" = "hello" ]` / `test "$x" = y` / `grep -q` 才算断言；只 echo 不算。 */
const SHELL_ASSERT = /\[\s*"?\$[A-Za-z_]\w*"?\s*=\s*"|\btest\s+"?\$[A-Za-z_]\w*"?\s*=|\bgrep\s+-q\b/;

/** 去掉 `javac -version` / `java --version` 这类探测，免得「查了版本」被读成「编译过」。 */
export function stripVersionProbes(command: string): string {
  return command.replace(
    /\b(?:java|javac|mvn|gradle|node|npm|pnpm|yarn|go|cargo|python3?|pytest|tsc|dotnet)\s+(?:--version|-version|-v)\b/g,
    ' '
  );
}

/**
 * 去掉引号里的字面量，只用于判断「执行过什么工具」。
 *
 * `echo 'javac: NOT FOUND'` 里的 javac 只是要打印的字，不是跑过的命令；而
 * `[ "$out" = "hello jwp" ]` 这种断言本身要靠引号才认得出，所以断言按原文判。
 */
function stripQuoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** 一条 shell 命令能读出哪几类证据（可能同时有编译与断言）。 */
export function shellEvidenceKinds(command: string): EvidenceKind[] {
  const executed = stripVersionProbes(stripQuoted(command));
  const raw = stripVersionProbes(command);
  const kinds: EvidenceKind[] = [];
  // 断言先判：`mvn -DskipTests package` 里的 skipTests 不算测试，但末尾的
  // 字符串比较算功能验证。
  if (SHELL_TEST.test(executed) || SHELL_ASSERT.test(raw)) kinds.push('tests');
  if (SHELL_BUILD.test(executed) || SHELL_MAKE.test(executed)) kinds.push('compile');
  return kinds;
}

/**
 * 一个步骤能读出哪几类证据。
 *
 * `test.run` 沿用老口径：没写命令或命令不像构建的，都算测试。`shell.run` 按
 * 命令形态判。其他工具（echo 式的 fs.list、chmod 之类）一律没有证据。
 */
export function stepEvidenceKinds(step: { tool: string; args?: unknown }): EvidenceKind[] {
  const args = step.args as { command?: unknown } | undefined;
  const command = typeof args?.command === 'string' ? args.command : undefined;
  if (step.tool === 'test.run') {
    if (command === undefined) return ['tests'];
    return COMPILE_COMMAND.test(command) ? ['compile'] : ['tests'];
  }
  if (step.tool === 'shell.run') return command ? shellEvidenceKinds(command) : [];
  return [];
}

/** 诊断与截屏本身就是检查动作：它们不跑命令，但能看见结果。 */
const OBSERVING_TOOLS = new Set(['code.diagnostics', 'screen.capture']);

/**
 * 这份计划里有没有「能观察改动效果」的动作。
 *
 * 用于计划门禁与评审辩题：没有的话才值得问「这次改动打算怎么验证」，有的话
 * 就不该再去追着要某一种特定工具。
 */
export function planHasObservableEvidence(steps: readonly { tool: string; args?: unknown }[]): boolean {
  return steps.some(step => OBSERVING_TOOLS.has(step.tool) || stepEvidenceKinds(step).length > 0);
}
