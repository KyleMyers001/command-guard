import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import {
  approvalTimeoutMs,
  describeTimeout,
  approvalExpired,
  EXPIRED_ADVICE,
  EXPIRED_MESSAGE,
} from './approval.ts';
import {visible, type GuardTool} from './policy.ts';

export interface Invocation {
  tool: GuardTool;
  input: Record<string, unknown>;
  // The Bash command, or the file tool's path argument.
  target: string;
  // What rules are matched against: the command as written and its canonical
  // spelling, or every path spelling.
  targets: string[];
}

export function block(
  reason: string,
  advice = 'Do not retry or work around this guard.',
): ToolCallEventResult {
  return {block: true, reason: `${reason} ${advice}`};
}

// `cause` names what asked: a policy selector or a command-analysis reason.
function approvalMessage(
  cause: string,
  call: Invocation,
  cwd: string,
  timeoutMs: number,
): string {
  const isBash = call.tool === 'bash';
  const action = isBash ? call.target : JSON.stringify(call.input, null, 2);

  const lines = [
    cause,
    `Working directory: ${cwd}`,
    ...(isBash ? [] : [`Resolved paths: ${call.targets.join(', ')}`]),
    '',
    action,
    '',
    `Approve this invocation once? No answer within ${describeTimeout(timeoutMs)} denies it.`,
  ];

  return visible(lines.join('\n'));
}

// Returns a block result unless the user approves this exact invocation.
export async function requestApproval(
  cause: string,
  call: Invocation,
  event: ToolCallEvent,
  ctx: ExtensionContext,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<ToolCallEventResult | undefined> {
  if (!ctx.hasUI || ctx.mode === 'json' || ctx.mode === 'print') {
    return block('Approval required, but no approval UI is available.');
  }

  // Another extension could rewrite the input while the dialog is open.
  const snapshot = JSON.stringify(call.input);
  const timeout = approvalTimeoutMs(env);

  try {
    const asked = now();
    const approved = await ctx.ui.confirm(
      'Command guard — approval required',
      approvalMessage(cause, call, ctx.cwd, timeout),
      {signal: ctx.signal, timeout},
    );

    const unchanged = snapshot === JSON.stringify(event.input);
    if (
      !ctx.signal?.aborted &&
      unchanged &&
      approvalExpired(now() - asked, timeout)
    ) {
      return block(EXPIRED_MESSAGE, EXPIRED_ADVICE);
    }
    if (approved !== true || ctx.signal?.aborted || !unchanged) {
      return block('Approval denied, cancelled, or invocation changed.');
    }
  } catch {
    return block('Approval could not be obtained.');
  }

  return undefined;
}
