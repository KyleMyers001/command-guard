import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {viewStats} from '../extensions/command-guard/invocations.ts';
import {fixture} from './helpers/fixtures.ts';

// EL-115, PR 3, round 6: the invocation view is built when a `BashCmdRegex`
// rule reads it, so a policy without one costs what `main` costs.

const repository = resolve(import.meta.dirname, '..');

// Prompts are answered "no": an ASK blocks, and is told from a deny by a count.
async function run(
  guard: ReturnType<typeof createCommandGuard>,
  command: string,
) {
  let prompts = 0;
  const result = await guard(
    {
      type: 'tool_call',
      toolCallId: 'lazy',
      toolName: 'bash',
      input: {command},
    } as ToolCallEvent,
    {
      cwd: repository,
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

function writePolicy(path: string, deny: string[], ask: string[] = []) {
  writeFileSync(path, JSON.stringify({version: 1, permissions: {deny, ask}}));
}

const edge = [
  'ls',
  'echo hi',
  `${'find . -exec '.repeat(18)}echo ${'+ '.repeat(12)}`,
  `find . ${'-exec -exec -exec + '.repeat(200)}`,
  `sudo ${'x '.repeat(989)}${'a'.repeat(6000)}`,
  `sudo ${'abcdefg '.repeat(990)}`,
  `${'sudo '.repeat(8)}${'abcdefg '.repeat(900)}`,
  'git push --force origin x',
  `FOO=1 viewpm -r publish; find . ${'-exec a \\; '.repeat(300)}`,
];

async function builtBy(
  guard: ReturnType<typeof createCommandGuard>,
  commands: string[],
) {
  const before = viewStats.built;
  for (const command of commands) await run(guard, command);
  return viewStats.built - before;
}

test('the shipped policy never builds the view', async () => {
  const guard = createCommandGuard({
    policyPath: join(repository, 'command-guard.json'),
  });
  assert.equal(await builtBy(guard, edge), 0);
});

test('a policy with no view rule never builds the view', async t => {
  const policy = join(fixture(t), 'policy.json');
  writePolicy(
    policy,
    ['BashRegex(^viewpm -r publish)', 'Bash(git push *)'],
    ['BashRegex(^viewnpm publish)'],
  );
  const guard = createCommandGuard({policyPath: policy});
  assert.equal(await builtBy(guard, edge), 0);
});

test('a BashCmdRegex deny or ask rule builds the view, as before', async t => {
  const policy = join(fixture(t), 'policy.json');
  const guard = createCommandGuard({policyPath: policy});

  writePolicy(policy, ['BashCmdRegex(^viewpm -r publish)']);
  assert.equal(await builtBy(guard, ['ls']), 1);
  assert.equal(await run(guard, 'FOO=1 /usr/bin/viewpm -r publish'), 'DENY');
  assert.equal(await run(guard, 'echo viewpm -r publish'), 'ALLOW');
  assert.equal(await run(guard, `sudo ${'x '.repeat(1100)}`), 'ALLOW');
  assert.equal(
    await run(guard, `sudo ${'x '.repeat(1100)}viewpm -r publish`),
    'DENY',
  );

  writePolicy(policy, [], ['BashCmdRegex(^viewpm -r publish)']);
  assert.equal(await builtBy(guard, ['ls']), 1);
  assert.equal(await run(guard, 'sudo viewpm -r publish'), 'ASK');
  assert.equal(await run(guard, 'viewpm -r build'), 'ALLOW');
});

test('a policy reload starts and stops building the view', async t => {
  const policy = join(fixture(t), 'policy.json');
  const guard = createCommandGuard({policyPath: policy});

  writePolicy(policy, ['BashRegex(^x)']);
  assert.equal(await builtBy(guard, ['ls', 'echo hi']), 0);
  writePolicy(policy, ['BashRegex(^x)', 'BashCmdRegex(^viewpm -r publish)']);
  assert.equal(await builtBy(guard, ['ls']), 1);
  writePolicy(policy, ['BashRegex(^x)']);
  assert.equal(await builtBy(guard, ['ls']), 0);
});

test('the view is built once per command, and only when read', () => {
  const before = viewStats.built;
  const analysis = analyzeCommand('sudo viewpm -r publish', repository);
  assert.equal(viewStats.built, before);
  assert.ok(analysis.invocations?.includes('viewpm -r publish'));
  assert.ok(analysis.invocations);
  assert.equal(viewStats.built, before + 1);
  // A command with no view stays without one, and is not built again.
  const none = analyzeCommand(`sudo ${'x '.repeat(1100)}`, repository);
  assert.equal(none.invocations, undefined);
  assert.equal(none.invocations, undefined);
  assert.equal(viewStats.built, before + 2);
});

test('under the shipped policy the edge inputs are decided in a few ms', async () => {
  const guard = createCommandGuard({
    policyPath: join(repository, 'command-guard.json'),
  });
  await run(guard, 'ls');
  for (const command of edge) {
    const start = performance.now();
    await run(guard, command);
    const took = performance.now() - start;
    assert.ok(took < 100, `${command.slice(0, 30)} took ${took} ms`);
  }
});
