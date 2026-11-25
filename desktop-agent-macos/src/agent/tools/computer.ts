import type { TaskGrant } from '../../shared/contracts';
import type { LocalContext, LocalStepOutcome } from '../local-plugins';
import { computer } from '../computer/service';
import type { ComputerArgs, ComputerToolResult } from '../computer/types';

function contextOf(ctx: LocalContext) {
  return { stepId: ctx.stepId, isCancelled: ctx.isCancelled };
}

function outcome(result: ComputerToolResult): LocalStepOutcome {
  if (result.code === 'NOT_VERIFIED') {
    return {
      result,
      verified: false,
      failure: result.verification?.reason ?? '操作结果未验证',
      errorCode: 'COMMAND_FAILED'
    };
  }
  return { result, verified: result.verified === true, failure: null, errorCode: 'COMMAND_FAILED' };
}

async function run(
  grant: TaskGrant,
  ctx: LocalContext,
  call: () => Promise<ComputerToolResult>
): Promise<LocalStepOutcome> {
  return outcome(await call());
}

export const computerTools = {
  capabilities: (grant: TaskGrant, _args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.capabilities(grant, contextOf(ctx))),
  windows: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.windows(grant, args, contextOf(ctx))),
  screenshot: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.screenshot(grant, args, contextOf(ctx))),
  tree: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.tree(grant, args, contextOf(ctx))),
  find: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.find(grant, args, contextOf(ctx))),
  click: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.click(grant, args, contextOf(ctx))),
  typeText: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.typeText(grant, args, contextOf(ctx))),
  keypress: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.keypress(grant, args, contextOf(ctx))),
  scroll: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.scroll(grant, args, contextOf(ctx))),
  drag: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.drag(grant, args, contextOf(ctx))),
  focus: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.focus(grant, args, contextOf(ctx))),
  verify: (grant: TaskGrant, args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.verify(grant, args, contextOf(ctx))),
  stop: (grant: TaskGrant, _args: ComputerArgs, ctx: LocalContext) =>
    run(grant, ctx, () => computer.stop(grant, contextOf(ctx)))
};
