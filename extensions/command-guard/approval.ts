// How long an approval prompt waits. Silence, expiry and any other non-"yes"
// answer block the call; nothing here ever turns a timeout into an approval.
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const MIN_APPROVAL_TIMEOUT_MS = 10_000;
export const MAX_APPROVAL_TIMEOUT_MS = 1_800_000;
export const APPROVAL_TIMEOUT_ENV = 'COMMAND_GUARD_APPROVAL_TIMEOUT_S';

// Positive whole seconds, clamped to 10 s - 30 min. Anything else (unset,
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

// True when the answer did not arrive within the window. Pi reports an expired
// dialog and a "no" the same way (false), so a wait that used the whole window
// counts as expiry. A "yes" after the deadline is expired too: it is never
// honoured. `waitedMs` must come from a monotonic clock; a clock that is not
// a finite number cannot show the answer was on time, so it counts as expired.
export function approvalExpired(waitedMs: number, timeoutMs: number): boolean {
  return !Number.isFinite(waitedMs) || waitedMs >= timeoutMs;
}

export const EXPIRED_MESSAGE =
  'Not approved in time; nothing ran. Skip it or ask the user directly;';

// The agent should move on, not ask again.
export const EXPIRED_ADVICE = 'do not retry or work around this guard.';
