import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {fixture} from './helpers/fixtures.ts';
import {rule} from './helpers/policy-rule.ts';
import {verdict} from './helpers/verdict.ts';

// EL-115, PR 3, rounds 3 and 4: the view is built in time linear in the words
// of a command of bounded size. Past a limit there is no view, and a
// `BashCmdRegex` rule then matches: a deny denies, an ask asks.

const cwd = process.cwd();
const repeat = (prefix: string, times: number, tail: string) =>
  `${prefix}${'find . -exec '.repeat(times)}${tail}`;
const words = (prefix: string, word: string, times: number) =>
  `${prefix}${`${word} `.repeat(times)}`;

function ms(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function matcher(t: Parameters<typeof rule>[0], selector: string) {
  const compiled = rule(t, selector);
  return (command: string) => {
    const {canonical, invocations} = analyzeCommand(command, cwd);
    return matches(
      compiled,
      'bash',
      [command, canonical],
      cwd,
      cwd,
      invocations,
    );
  };
}

// What a policy of one `BashCmdRegex` rule decides, as the guard would.
async function decide(
  t: Parameters<typeof rule>[0],
  kind: 'deny' | 'ask',
  command: string,
) {
  const policyPath = join(fixture(t), 'policy.json');
  const rules = {deny: [] as string[], ask: [] as string[]};
  rules[kind].push('BashCmdRegex(^pnpm -r publish)');
  writeFileSync(policyPath, JSON.stringify({version: 1, permissions: rules}));

  let prompts = 0;
  const result = await createCommandGuard({policyPath})(
    {
      type: 'tool_call',
      toolCallId: 'bounds',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent,
    {
      cwd,
      hasUI: true,
      mode: 'tui',
      signal: new AbortController().signal,
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    } as unknown as ExtensionContext,
  );
  if (!result) return 'ALLOW';
  return prompts > 0 ? 'ASK' : 'DENY';
}

// Inputs of 40k words and more are mostly the parser's own time, which `main`
// spends too; the rest are well inside the size limit.
const LIMIT = 100;
const HUGE_LIMIT = 400;
const HUGE = /k( |$)|k-word|k -exec/u;

test('large and repetitive commands are analyzed in a few ms', () => {
  analyzeCommand('find . -exec ls \\;', cwd);
  const quoted = "'a b' ";
  const inputs: Record<string, string> = {
    'find x500': repeat('', 500, 'ls'),
    'sudo find x500': repeat('sudo ', 500, 'ls'),
    'find x20': repeat('', 20, 'ls'),
    'sudo find x16': repeat('sudo ', 16, 'ls'),
    'sudo quoted x12k (72 KB)': words('sudo echo ', quoted.trim(), 12000),
    'sudo git x5k': words('sudo ', 'git', 5000),
    'sudo git x40k': words('sudo ', 'git', 40000),
    'sudo find x50k': words('sudo ', 'find', 50000),
    'sudo x150k': words('sudo ', 'x', 150000),
    'sudo quoted x900 (at the limit)': words('sudo ', quoted.trim(), 900),
    'sudo git x990': words('sudo ', 'git', 990),
    'sudo find x990': words('sudo ', 'find', 990),
    'sudo gh x990': words('sudo ', 'gh', 990),
    '20k -exec payloads': `find . ${'-exec a \\; '.repeat(20000)}`,
    '100k-word payload': words('find . -exec ', 'x', 100000),
  };
  for (const [name, command] of Object.entries(inputs)) {
    let took = 0;
    assert.doesNotThrow(() => {
      took = ms(() => analyzeCommand(command, cwd));
    }, name);
    assert.ok(
      took < (HUGE.test(name) ? HUGE_LIMIT : LIMIT),
      `${name} took ${took} ms`,
    );
  }
});

test('a command past a size limit has no view; below it, every start', () => {
  const none = [
    words('sudo ', 'x', 1001),
    words('sudo ', "'a b'", 12000),
    words('sudo ', 'git', 40000),
    words('sudo ', 'git', 990),
    words('sudo ', 'gh', 990),
    words('sudo ', 'find', 50000),
    words('sudo ', 'x', 150000),
    `sudo echo ${'a'.repeat(9000)}`,
  ];
  for (const command of none) {
    assert.equal(analyzeCommand(command, cwd).invocations, undefined);
  }
  for (const command of [
    words('sudo ', 'x', 990),
    words('sudo ', 'git', 30),
    `sudo echo ${'a'.repeat(8000)}`,
  ]) {
    assert.ok(analyzeCommand(command, cwd).invocations, command.slice(0, 30));
  }
});

test('no view: a deny rule denies and an ask rule asks, whatever the command', async t => {
  const padded = [
    words('sudo ', 'x', 5000),
    `echo ${'a'.repeat(9000)}`,
    `find . ${'-exec a \\; '.repeat(400)}-exec pnpm -r build \\;`,
    'find . -exec sh -c "$X" \';\'',
    repeat('', 40, 'a'.repeat(1)).replace(
      'find . ',
      `${'x '.repeat(1100)}find . `,
    ),
  ];
  for (const command of padded) {
    assert.equal(analyzeCommand(command, cwd).invocations, undefined);
    assert.equal(
      await decide(t, 'deny', command),
      'DENY',
      command.slice(0, 40),
    );
    assert.equal(await decide(t, 'ask', command), 'ASK', command.slice(0, 40));
  }
  // With a view the rule is as exact as before.
  for (const kind of ['deny', 'ask'] as const) {
    assert.equal(await decide(t, kind, 'pnpm -r build'), 'ALLOW');
    assert.equal(await decide(t, kind, 'echo pnpm -r publish'), 'ALLOW');
    assert.notEqual(await decide(t, kind, 'pnpm -r publish'), 'ALLOW');
  }
});

test('padding a command with find -exec payloads does not hide a publish', async t => {
  for (const count of [100, 256, 257, 258, 300, 400, 1000]) {
    const command = `FOO=1 pnpm -r publish; find . ${'-exec a \\; '.repeat(count)}`;
    assert.equal(await decide(t, 'deny', command), 'DENY', `${count}`);
  }
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  const padding = '-exec a \\; '.repeat(257);
  assert.equal(cmd(`find . ${padding}-exec pnpm -r publish \\;`), true);
  assert.equal(cmd(`find . ${padding}-exec pnpm -r build \\;`), false);
});

test('a find payload is read once, so a mention inside one is no command', t => {
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    'find . -exec echo -exec pnpm -r publish \\;',
    'find . -exec echo -execdir pnpm -r publish \\;',
    'find . -name -exec pnpm -r build \\;',
  ]) {
    assert.equal(cmd(command), false, command);
  }
  for (const command of [
    'find . -exec find . -exec find . -exec pnpm -r publish \\; \\; \\;',
    'find . -exec echo \\; -exec pnpm -r publish \\;',
    'sudo find . -exec echo \\; -exec pnpm -r publish \\;',
    'sudo find . -name x find . -exec pnpm -r publish \\;',
    'find . -exec sudo find . -exec pnpm -r publish \\; \\;',
  ]) {
    assert.equal(cmd(command), true, command);
  }
});

test('an -exec that is a predicate operand does not hide the real one', t => {
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    'find . -name -exec -o -exec pnpm -r publish \\;',
    'find . -path -exec -o -exec pnpm -r publish \\;',
    'find . -newer -exec -o -exec pnpm -r publish \\;',
    'find . -newermt -exec -exec pnpm -r publish \\;',
    'find . -name -exec -exec pnpm -r publish \\;',
    'find . -iname -execdir -ok pnpm -r publish \\;',
    'find . -fprintf f -exec -exec pnpm -r publish \\;',
    'sudo find . -name -exec -o -exec pnpm -r publish \\;',
    // An operand the guard does not know is still found, inside the payload.
    'find . -somepredicate -exec -o -exec pnpm -r publish \\;',
    'find . -exec -o -exec -o -exec pnpm -r publish \\;',
  ]) {
    assert.equal(cmd(command), true, command);
  }
  assert.equal(cmd('find . -name -exec -o -exec pnpm -r build \\;'), false);
});

test('`+` ends a payload only after {}', t => {
  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    'find . -exec echo {} + -exec pnpm -r publish \\;',
    'find . -exec echo {} \\+ -exec pnpm -r publish \\;',
    // `+` here is an argument, so the payload runs on to `;` and is open.
    'find . -exec sudo + pnpm -r publish \\;',
  ]) {
    assert.equal(cmd(command), true, command);
  }
  assert.equal(cmd('find . -exec echo + pnpm -r publish \\;'), false);
});

test('a literal script run by find -exec is read', t => {
  const {invocations} = analyzeCommand(
    "find . -exec sh -c 'npm publish' \\;",
    cwd,
  );
  assert.ok(invocations?.includes('npm publish'));

  const cmd = matcher(t, 'BashCmdRegex(^pnpm -r publish)');
  for (const command of [
    "find . -exec sh -c 'pnpm -r publish' \\;",
    "find . -exec bash -lc 'cd x && pnpm -r publish' _ {} \\;",
    "find . -execdir eval 'pnpm -r publish' \\;",
    "find . -exec sh -c 'find . -exec pnpm -r publish \\\\;' \\;",
    'sh -c \'find . -exec sh -c "pnpm -r publish" \\;\'',
    "env A=1 find . -exec sh -c 'FOO=1 /bin/pnpm -r publish' \\;",
  ]) {
    assert.equal(cmd(command), true, command);
  }
  assert.equal(cmd("find . -exec sh -c 'pnpm -r build' \\;"), false);

  // A script it cannot read means no view, and no new decision.
  const unread = analyzeCommand('find . -exec sh -c "$X" \\;', cwd);
  assert.equal(unread.invocations, undefined);
  assert.deepEqual(
    unread.decisions,
    analyzeCommand('find . -exec ls \\;', cwd).decisions,
  );
});

test('shipped verdicts do not depend on the view', async () => {
  for (const [command, expected] of [
    [repeat('', 500, 'git push --force origin x'), 'DENY'],
    [repeat('sudo ', 50, 'git push --force origin x'), 'DENY'],
    [repeat('', 500, 'ls'), 'ALLOW'],
    [repeat('', 40, 'ls'), 'ALLOW'],
    [words('echo ', 'x', 5000), 'ALLOW'],
    [words('echo ', 'x', 150000), 'ALLOW'],
    ["find . -exec sh -c 'git push --force origin x' \\;", 'ASK'],
    ["find . -exec sh -c 'ls' \\;", 'ASK'],
    ['find . -exec ls \\;', 'ALLOW'],
  ] as const) {
    assert.equal(await verdict(command), expected, command.slice(0, 60));
  }
});
