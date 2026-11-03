import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {
  approvalTimeoutMs,
  describeTimeout,
} from '../extensions/command-guard/approval.ts';

// CG-AP-001..004: approvals that lapsed at the old 120 s limit (EL-115).
const repository = resolve(import.meta.dirname, '..');
// Asks under the production policy, so the prompt path is the real one.
const COMMAND = 'rm -rf build';
const DEFAULT_MS = 600_000;

function harness(
  env: NodeJS.ProcessEnv,
  answer: (clock: {ms: number}) => unknown,
) {
  const clock = {ms: 1_000_000};
  const controller = new AbortController();
  const prompts: [string, string, {timeout: number}][] = [];
  const event = {
    type: 'tool_call',
    toolCallId: 'approval-expiry',
    toolName: 'bash',
    input: {command: COMMAND},
  } as ToolCallEvent;
  const ctx = {
    cwd: repository,
    hasUI: true,
    mode: 'tui',
    signal: controller.signal,
    ui: {
      confirm: async (title: string, message: string, options: never) => {
        prompts.push([title, message, options]);
        return answer(clock);
      },
    },
  } as unknown as ExtensionContext;
  const guard = createCommandGuard({env, now: () => clock.ms});
  return {prompts, controller, event, clock, call: () => guard(event, ctx)};
}

// Pi answers false both for "no" and for a lapsed dialog.
const lapses = (clock: {ms: number}, ms = DEFAULT_MS) => {
  clock.ms += ms;
  return false;
};

test('default approval window is 10 minutes and the prompt says so', async () => {
  const h = harness({}, () => true);
  assert.equal(await h.call(), undefined);
  assert.equal(h.prompts[0][2].timeout, 600_000);
  assert.match(h.prompts[0][1], /No answer within 10 minutes denies it\./);
  assert.doesNotMatch(h.prompts[0][1], /120/);
});

for (const [value, ms, text] of [
  ['90', 90_000, '90 seconds'],
  ['120', 120_000, '2 minutes'],
  ['45', 45_000, '45 seconds'],
  [' 300 ', 300_000, '5 minutes'],
  ['1', 30_000, '30 seconds'],
  ['29', 30_000, '30 seconds'],
  ['30', 30_000, '30 seconds'],
  ['1800', 1_800_000, '30 minutes'],
  ['1801', 1_800_000, '30 minutes'],
  ['99999999999999999999', 1_800_000, '30 minutes'],
] as const) {
  test(`COMMAND_GUARD_APPROVAL_TIMEOUT_S=${JSON.stringify(value)} gives ${ms} ms`, async () => {
    const env = {COMMAND_GUARD_APPROVAL_TIMEOUT_S: value};
    assert.equal(approvalTimeoutMs(env), ms);
    const h = harness(env, () => true);
    await h.call();
    assert.equal(h.prompts[0][2].timeout, ms);
    assert.ok(h.prompts[0][1].includes(`No answer within ${text} denies it.`));
  });
}

for (const value of [
  '',
  ' ',
  'abc',
  '0',
  '00',
  '-5',
  '1.5',
  '1e3',
  '0x10',
  'Infinity',
  'NaN',
  '10s',
  '10 min',
]) {
  test(`invalid COMMAND_GUARD_APPROVAL_TIMEOUT_S=${JSON.stringify(value)} falls back to the default`, async () => {
    const env = {COMMAND_GUARD_APPROVAL_TIMEOUT_S: value};
    assert.equal(approvalTimeoutMs(env), DEFAULT_MS);
    const h = harness(env, () => true);
    await h.call();
    assert.equal(h.prompts[0][2].timeout, DEFAULT_MS);
  });
}

test('unset variable uses the default and durations read naturally', () => {
  assert.equal(approvalTimeoutMs({}), DEFAULT_MS);
  assert.equal(describeTimeout(60_000), '1 minute');
  assert.equal(describeTimeout(1_800_000), '30 minutes');
  assert.equal(describeTimeout(30_000), '30 seconds');
  assert.equal(describeTimeout(90_000), '90 seconds');
});

test('an expired approval blocks with a clear re-request message', async () => {
  const h = harness({}, clock => lapses(clock));
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /expired/i);
  assert.match(result?.reason ?? '', /no answer within 10 minutes/);
  assert.match(result?.reason ?? '', /nothing ran/);
  assert.match(result?.reason ?? '', /re-request/i);
  assert.doesNotMatch(result?.reason ?? '', /do not retry/i);
  assert.equal(h.prompts.length, 1);
});

test('expiry message follows a configured window', async () => {
  const env = {COMMAND_GUARD_APPROVAL_TIMEOUT_S: '60'};
  const h = harness(env, clock => lapses(clock, 60_000));
  const result = await h.call();
  assert.match(result?.reason ?? '', /no answer within 1 minute,/);
});

test('re-requesting after expiry prompts again and can be approved', async () => {
  let attempt = 0;
  const h = harness({}, clock => (++attempt === 1 ? lapses(clock) : true));
  assert.equal((await h.call())?.block, true);
  assert.equal(await h.call(), undefined);
  assert.equal(h.prompts.length, 2);
});

for (const answer of [false, undefined, null, 'yes', 0]) {
  test(`silence or ${String(answer)} at expiry never approves`, async () => {
    const h = harness({}, clock => {
      clock.ms += DEFAULT_MS * 10;
      return answer;
    });
    assert.equal((await h.call())?.block, true);
  });
}

test('an explicit denial keeps the usual do-not-retry message', async () => {
  const h = harness({}, () => false);
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /denied/i);
  assert.match(result?.reason ?? '', /do not retry/i);
  assert.doesNotMatch(result?.reason ?? '', /expired/i);
});

test('a prompt that lapses just under the window is still treated as expiry', async () => {
  const h = harness({}, clock => lapses(clock, DEFAULT_MS - 500));
  assert.match((await h.call())?.reason ?? '', /expired/i);
});

test('a quick "no" is not reported as expiry', async () => {
  const h = harness({}, clock => lapses(clock, DEFAULT_MS - 5_000));
  assert.doesNotMatch((await h.call())?.reason ?? '', /expired/i);
});

test('cancellation at the deadline is cancellation, not expiry', async () => {
  const h = harness({}, clock => {
    h.controller.abort();
    return lapses(clock);
  });
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.doesNotMatch(result?.reason ?? '', /expired/i);
});

test('a rewritten invocation is not reported as expiry', async () => {
  const h = harness({}, clock => {
    h.event.input = {command: 'rm -rf elsewhere'};
    return lapses(clock);
  });
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /invocation changed/);
  assert.doesNotMatch(result?.reason ?? '', /expired/i);
});

test('print and JSON modes still block asks without any window', async () => {
  const h = harness({}, () => true);
  const guard = createCommandGuard({env: {}});
  const result = await guard(h.event, {
    cwd: repository,
    hasUI: false,
    mode: 'print',
  } as unknown as ExtensionContext);
  assert.equal(result?.block, true);
  assert.equal(h.prompts.length, 0);
});
