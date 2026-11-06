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

// CG-AP-001..004 and EL-117: approval expiry. The default window stays 120 s;
// an expired or unanswered prompt blocks and tells the agent to move on.
const repository = resolve(import.meta.dirname, '..');
// Source deletion still asks after build-directory cleanup is exempted.
const COMMAND = 'rm -rf src';
const DEFAULT_MS = 120_000;

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

test('default approval window is 2 minutes and the prompt says so', async () => {
  const h = harness({}, () => true);
  assert.equal(await h.call(), undefined);
  assert.equal(h.prompts[0][2].timeout, 120_000);
  assert.match(h.prompts[0][1], /No answer within 2 minutes denies it\./);
});

for (const [value, ms, text] of [
  ['90', 90_000, '90 seconds'],
  ['120', 120_000, '2 minutes'],
  ['45', 45_000, '45 seconds'],
  [' 300 ', 300_000, '5 minutes'],
  ['1', 10_000, '10 seconds'],
  ['9', 10_000, '10 seconds'],
  ['10', 10_000, '10 seconds'],
  ['11', 11_000, '11 seconds'],
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
  assert.equal(describeTimeout(10_000), '10 seconds');
  assert.equal(describeTimeout(120_000), '2 minutes');
  assert.equal(describeTimeout(90_000), '90 seconds');
});

const MOVE_ON =
  /Not approved in time; nothing ran\. Skip it or ask the user directly/;
const INVITES_RETRY = /re-?request|prompted again|try again|ask again/i;

test('an expired approval blocks and tells the agent to move on', async () => {
  const h = harness({}, clock => lapses(clock));
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', MOVE_ON);
  assert.match(result?.reason ?? '', /do not retry/i);
  assert.doesNotMatch(result?.reason ?? '', INVITES_RETRY);
  assert.equal(h.prompts.length, 1);
});

test('expiry follows a configured window', async () => {
  const env = {COMMAND_GUARD_APPROVAL_TIMEOUT_S: '60'};
  const h = harness(env, clock => lapses(clock, 60_000));
  assert.match((await h.call())?.reason ?? '', MOVE_ON);
  const early = harness(env, clock => lapses(clock, 59_000));
  assert.match((await early.call())?.reason ?? '', /denied/i);
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
  assert.doesNotMatch(result?.reason ?? '', /Not approved in time/);
});

test('only a wait that used the whole window is reported as expiry', async () => {
  for (const early of [1, 100, 1_000, 5_000]) {
    const h = harness({}, clock => lapses(clock, DEFAULT_MS - early));
    const result = await h.call();
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? '', /denied/i);
    assert.doesNotMatch(result?.reason ?? '', /Not approved in time/);
  }
});

// Sophie's ruling (EL-115): no late approval. A "yes" is only honoured when
// it arrives within the window, measured on the monotonic clock.
test('an on-time "yes" runs the command', async () => {
  for (const ms of [0, 1_000, DEFAULT_MS - 1]) {
    const h = harness({}, clock => {
      clock.ms += ms;
      return true;
    });
    assert.equal(await h.call(), undefined, `answered after ${ms} ms`);
  }
});

test('a late "yes" blocks with the expired message', async () => {
  for (const late of [1, 1_000, DEFAULT_MS * 10]) {
    const h = harness({}, clock => {
      clock.ms += DEFAULT_MS + late;
      return true;
    });
    const result = await h.call();
    assert.equal(result?.block, true, `answered ${late} ms late`);
    assert.match(result?.reason ?? '', MOVE_ON);
    assert.doesNotMatch(result?.reason ?? '', INVITES_RETRY);
  }
});

test('a "yes" exactly at the deadline is expired, not approved', async () => {
  const h = harness({}, clock => {
    clock.ms += DEFAULT_MS;
    return true;
  });
  assert.match((await h.call())?.reason ?? '', MOVE_ON);
});

test('a late "yes" is judged against a configured window', async () => {
  const env = {COMMAND_GUARD_APPROVAL_TIMEOUT_S: '60'};
  const late = harness(env, clock => {
    clock.ms += 61_000;
    return true;
  });
  assert.equal((await late.call())?.block, true);
  const onTime = harness(env, clock => {
    clock.ms += 59_000;
    return true;
  });
  assert.equal(await onTime.call(), undefined);
});

test('a late "no" blocks with the expired message', async () => {
  const h = harness({}, clock => lapses(clock, DEFAULT_MS + 5_000));
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', MOVE_ON);
});

test('a late "yes" on a cancelled or rewritten invocation still blocks', async () => {
  const cancelled = harness({}, clock => {
    cancelled.controller.abort();
    clock.ms += DEFAULT_MS * 2;
    return true;
  });
  const cancelledResult = await cancelled.call();
  assert.equal(cancelledResult?.block, true);
  assert.match(cancelledResult?.reason ?? '', /cancelled/i);
  assert.doesNotMatch(cancelledResult?.reason ?? '', /Not approved in time/);
  const rewritten = harness({}, clock => {
    rewritten.event.input = {command: 'rm -rf elsewhere'};
    clock.ms += DEFAULT_MS * 2;
    return true;
  });
  const rewrittenResult = await rewritten.call();
  assert.equal(rewrittenResult?.block, true);
  assert.match(rewrittenResult?.reason ?? '', /invocation changed/);
  assert.doesNotMatch(rewrittenResult?.reason ?? '', /Not approved in time/);
});

test('the default clock is monotonic', async () => {
  const realNow = Date.now;
  let wall = 1_000_000;
  Date.now = () => (wall += DEFAULT_MS * 10);
  try {
    const guard = createCommandGuard({env: {}});
    const event = {
      type: 'tool_call',
      toolCallId: 'monotonic',
      toolName: 'bash',
      input: {command: COMMAND},
    } as ToolCallEvent;
    const ctx = {
      cwd: repository,
      hasUI: true,
      mode: 'tui',
      ui: {confirm: async () => true},
    } as unknown as ExtensionContext;
    // The wall clock leaps ahead; an on-time answer must still run.
    assert.equal(await guard(event, ctx), undefined);
  } finally {
    Date.now = realNow;
  }
});

test('cancellation at the deadline is cancellation, not expiry', async () => {
  const h = harness({}, clock => {
    h.controller.abort();
    return lapses(clock);
  });
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /cancelled/i);
  assert.doesNotMatch(result?.reason ?? '', /Not approved in time/);
});

test('a rewritten invocation is not reported as expiry', async () => {
  const h = harness({}, clock => {
    h.event.input = {command: 'rm -rf elsewhere'};
    return lapses(clock);
  });
  const result = await h.call();
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? '', /invocation changed/);
  assert.doesNotMatch(result?.reason ?? '', /Not approved in time/);
});

// EL-117: the mode decides, not hasUI, so a host reporting hasUI with json or
// print mode still gets no prompt.
for (const mode of ['print', 'json'] as const) {
  for (const hasUI of [false, true]) {
    test(`${mode} mode with hasUI ${hasUI} blocks asks without prompting`, async () => {
      const h = harness({}, () => true);
      const guard = createCommandGuard({env: {}});
      const result = await guard(h.event, {
        cwd: repository,
        hasUI,
        mode,
        ui: {confirm: async () => true},
      } as unknown as ExtensionContext);
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? '', /no approval UI/);
      assert.equal(h.prompts.length, 0);
    });
  }
}

test('a clock that is not a finite number counts as expired', async () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    let calls = 0;
    const guard = createCommandGuard({
      env: {},
      now: () => (++calls === 1 ? 0 : bad),
    });
    const ctx = {
      cwd: repository,
      hasUI: true,
      mode: 'tui',
      ui: {confirm: async () => true},
    } as unknown as ExtensionContext;
    const event = {
      type: 'tool_call',
      toolCallId: 'nan-clock',
      toolName: 'bash',
      input: {command: COMMAND},
    } as ToolCallEvent;
    const result = await guard(event, ctx);
    assert.equal(result?.block, true, `clock ${bad}`);
    assert.match(result?.reason ?? '', MOVE_ON);
  }
});

test('the default environment is process.env', async () => {
  const name = 'COMMAND_GUARD_APPROVAL_TIMEOUT_S';
  const saved = process.env[name];
  const seen: number[] = [];
  const ctx = {
    cwd: repository,
    hasUI: true,
    mode: 'tui',
    ui: {
      confirm: async (_t: string, _m: string, options: {timeout: number}) => {
        seen.push(options.timeout);
        return true;
      },
    },
  } as unknown as ExtensionContext;
  const event = {
    type: 'tool_call',
    toolCallId: 'process-env',
    toolName: 'bash',
    input: {command: COMMAND},
  } as ToolCallEvent;

  try {
    for (const [value, ms] of [
      ['45', 45_000],
      ['5', 10_000],
      ['soon', DEFAULT_MS],
      [undefined, DEFAULT_MS],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      // No `env` option: the guard must read the real process environment.
      assert.equal(await createCommandGuard({})(event, ctx), undefined);
      assert.equal(seen.at(-1), ms, `value ${String(value)}`);
    }
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});
