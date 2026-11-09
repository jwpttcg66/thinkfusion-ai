/**
 * OpenCode Go 网关 2026-11-09 报的 chat 模型（公开的 `/models` 清单）。
 *
 * 放在 shared 是因为两个地方要用同一份：主进程的云端预设拿它当「还没读到
 * 网关时的兜底」，浏览器预览的 mock 拿它当同一行服务的候选。各抄一份会在
 * 下一次网关加模型时对不上，界面预览起来就像另一家服务。
 *
 * `-free` 三个不在这里（见 docs/implementation/OPENCODE_GO.md 第 6 节：
 * 明确不含中国大陆，且免费额度随时可能变）；配好 Key 后由 `/models` 读回，
 * 仍会出现在「选择模型」的候选里。
 */
export const OPENCODE_GO_MODELS: readonly string[] = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'grok-4.7',
  'gpt-5.6-luna',
  'gpt-6-luna',
  'claude-haiku-5-5',
  'gemini-4-argon',
  'kimi-k2.7-code',
  'kimi-k3',
  'kimi-k3.1-pro',
  'minimax-m3',
  'minimax-m3.1-flash',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'longcat-2.0',
  'step-5-preview',
  'hy3',
  'hy4',
  'hy4-preview',
  'muse-spark-1.2-contributor',
  'muse-spark-1.3-contributor',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus'
];
