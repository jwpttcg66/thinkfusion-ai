import { z } from 'zod';
import { PROTOCOL, TOOL_NAMES } from './contracts';

/**
 * Input validation for every IPC entry point and for data coming back from the
 * runtime process. Main process validates before acting; the runtime validates
 * again before executing. Same schemas, two independent checks.
 */

const presetEnum = z.enum(['read-only', 'workspace-write', 'danger-full-access']);

export const SubmitPromptSchema = z
  .object({
    prompt: z.string().min(1).max(20_000),
    permissionPreset: presetEnum,
    workspaceRoot: z.string().min(1).max(2000).optional()
  })
  .strict();

export const ApprovePlanSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    roundId: z.string().min(1).max(80),
    planId: z.string().min(1).max(80),
    approved: z.literal(true)
  })
  .strict();

export const RejectPlanSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    planId: z.string().min(1).max(80),
    reason: z.string().max(500).optional()
  })
  .strict();

export const AnswerStepQuestionSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    stepId: z.string().min(1).max(200),
    answer: z.string().max(2000).optional(),
    cancelled: z.boolean().optional()
  })
  .strict()
  .refine(value => value.cancelled === true || (value.answer ?? '').trim().length > 0, {
    message: '要么给出回答，要么明确取消'
  });

export const ApproveStepSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    stepId: z.string().min(1).max(200),
    /** 「这一步之后同类别再问」——把逐次审批从惩罚变成一次性授权。 */
    remember: z.boolean().optional()
  })
  .strict();

export const RejectStepSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    stepId: z.string().min(1).max(200),
    reason: z.string().max(500).optional()
  })
  .strict();

export const TaskIdSchema = z.string().min(1).max(80);

export const ClarificationAnswerSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    answer: z.string().min(1).max(10_000)
  })
  .strict();

export const StepResultSchema = z
  .object({
    stepId: z.string().min(1).max(200),
    tool: z.enum(TOOL_NAMES),
    status: z.enum(['completed', 'failed', 'skipped']),
    verified: z.boolean(),
    result: z.unknown().optional(),
    /** 这一步实际用的参数；contracts.StepResult 一直带着它，schema 以前漏了。 */
    args: z.unknown().optional(),
    error: z.string().max(2000).optional(),
    durationMs: z.number().int().min(0)
  })
  .strict();

export const ExecutionReportSchema = z
  .object({
    protocol: z.literal(PROTOCOL),
    type: z.literal('execution_report'),
    taskId: z.string().min(1).max(80),
    roundId: z.string().max(80),
    planId: z.string().max(80),
    status: z.enum(['completed', 'partial', 'failed', 'cancelled']),
    results: z.array(StepResultSchema).max(30),
    errors: z
      .array(
        z
          .object({
            stepId: z.string().max(200).optional(),
            code: z.string().min(1).max(60),
            message: z.string().max(2000)
          })
          .strict()
      )
      .max(30),
    nextAction: z.enum(['continue', 'complete', 'retry', 'stop']),
    createdAt: z.number().int().positive(),
    // 可选：老报告没有账本，不能因此解析失败。
    evidence: z
      .object({
        refs: z
          .array(
            z.discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('file'),
                  path: z.string().min(1).max(4000),
                  line: z.number().int().min(1).optional(),
                  sha256: z.string().max(128).optional(),
                  lines: z.number().int().min(0).optional()
                })
                .strict(),
              z
                .object({
                  kind: z.literal('command'),
                  command: z.string().min(1).max(4000),
                  exitCode: z.number().int().nullable(),
                  at: z.number().int().positive(),
                  timedOut: z.boolean().optional(),
                  background: z.boolean().optional()
                })
                .strict(),
              z
                .object({
                  kind: z.literal('url'),
                  url: z.string().min(1).max(4000),
                  fetchedAt: z.number().int().positive()
                })
                .strict()
            ])
          )
          .max(60),
        primaryFamily: z.string().max(40).optional()
      })
      .strict()
      .optional(),
    // Runtime 的执行验收信息；老报告没有，不能因此失败。
    verification: z
      .object({
        verified: z.boolean(),
        /** 更严格的完成口径；老报告没有这个字段。 */
        fullyVerified: z.boolean().optional(),
        reasons: z.array(z.string().max(2000)).max(50),
        changedFiles: z.number().int().min(0),
        changedPaths: z.array(z.string().max(4000)).max(200).optional(),
        checks: z
          .object({
            compile: z.object({ status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().optional(), command: z.string().max(4000).optional(), detail: z.string().max(2000).optional(), output: z.string().max(400).optional() }).strict(),
            // V1.3：真机运行这一项；老报告没有它，不能因此解析失败。
            run: z.object({ status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().optional(), command: z.string().max(4000).optional(), detail: z.string().max(2000).optional(), output: z.string().max(400).optional() }).strict().optional(),
            tests: z.object({ status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().optional(), command: z.string().max(4000).optional(), detail: z.string().max(2000).optional(), output: z.string().max(400).optional() }).strict(),
            diagnostics: z.object({ status: z.enum(['passed', 'failed', 'skipped']), errors: z.number().int().min(0), warnings: z.number().int().min(0), source: z.string().max(100).optional(), path: z.string().max(4000).optional(), detail: z.string().max(2000).optional() }).strict(),
            changedFiles: z.array(z.string().max(4000)).max(200)
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((report, ctx) => {
    // A run that produced results must be attributable to the plan that was
    // approved, otherwise its output cannot be trusted or reported back. A
    // failure that never got as far as executing has nothing to attribute, so
    // empty ids are allowed there — and only there.
    if (report.status === 'failed') return;
    if (report.roundId.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roundId'], message: '非失败的报告必须携带 roundId' });
    }
    if (report.planId.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planId'], message: '非失败的报告必须携带 planId' });
    }
  });

export type ValidatedExecutionReport = z.infer<typeof ExecutionReportSchema>;

/** 终端 IPC：只允许附加到已存在的会话，sessionId 来自任务事件，不接受路径。 */
export const TerminalSessionIdSchema = z.string().min(1).max(80);

export const TerminalWriteSchema = z
  .object({
    sessionId: TerminalSessionIdSchema,
    /** 一次按键输入；粘贴大段文本也走这里，上限 64 KB。 */
    data: z.string().max(65_536)
  })
  .strict();

export const TerminalResizeSchema = z
  .object({
    sessionId: TerminalSessionIdSchema,
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200)
  })
  .strict();

export const CliAgentToggleSchema = z
  .object({
    id: z.string().min(1).max(60),
    enabled: z.boolean()
  })
  .strict();

/** 设置页的 CLI 软件源；真正的取值校验在 cli-software-source.ts 里做。 */
export const CliAgentSoftwareSourceSchema = z
  .object({
    id: z.string().min(1).max(60),
    command: z.string().min(1).max(500).optional(),
    softwareSource: z
      .object({
        kind: z.enum(['manual', 'npm', 'brew', 'url']),
        value: z.string().max(300),
        endpoint: z.string().max(300).optional(),
        note: z.string().max(120).optional()
      })
      .strict()
  })
  .strict();

/** 任务级 Worktree：只认 taskId，不接受路径——路径由主进程自己记账。 */
export const WorktreeCommitSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    message: z.string().min(1).max(200)
  })
  .strict();

export const WorktreeRemoveSchema = z
  .object({
    taskId: z.string().min(1).max(80),
    force: z.boolean().optional()
  })
  .strict();
