// How long an approval prompt waits. Silence, expiry and any other non-"yes"
// answer block the call; nothing here ever turns a timeout into an approval.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
export const MIN_APPROVAL_TIMEOUT_MS = 30_000;
export const MAX_APPROVAL_TIMEOUT_MS = 1_800_000;
export const APPROVAL_TIMEOUT_ENV = 'COMMAND_GUARD_APPROVAL_TIMEOUT_S';

// Pi reports an expired dialog and a "no" the same way (false), so expiry is
// recognised by the wait having used up (nearly) the whole timeout.
const EXPIRY_TOLERANCE_MS = 1_000;

// Positive whole seconds, clamped to 30 s - 30 min. Anything else (unset,
// empty, zero, negative, fractional, hex, exponent, text) uses the default.
export function approvalTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[APPROVAL_TIMEOUT_ENV]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  const seconds = Number(raw);
  if (seconds === 0) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(
    MAX_APPROVAL_TIMEOUT_MS,
    Math.max(MIN_APPROVAL_TIMEOUT_MS, seconds * 1000),
  );
}

export function describeTimeout(ms: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  return ms % 60_000 === 0
    ? unit(ms / 60_000, 'minute')
    : unit(ms / 1000, 'second');
}

export function expiredWithoutAnswer(
  approved: unknown,
  waitedMs: number,
  timeoutMs: number,
): boolean {
  return approved !== true && waitedMs >= timeoutMs - EXPIRY_TOLERANCE_MS;
}

export function expiredMessage(timeoutMs: number): string {
  return `Approval expired: no answer within ${describeTimeout(timeoutMs)}, so nothing ran.`;
}

// Replaces the usual "do not retry": here a retry is exactly right.
export const EXPIRED_ADVICE = 'Re-request the command to be prompted again.';
