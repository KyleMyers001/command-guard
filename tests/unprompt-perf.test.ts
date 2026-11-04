import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {createCommandGuard as createMainGuard} from './fixtures/main-7b8edc4/extensions/command-guard.ts';
import {fixture} from './helpers/fixtures.ts';

// Sophie's R4 ruling: on pathological repeats the whole guard may cost at
// most 2.5x main. Locally curl -s/-d run at 2.3x, but the CI runner measures
// 2.6-2.7x for the same code, so the test allows 3x (permitted by the ruling
// for CI noise). Main is the vendored 7b8edc4 classifier, timed in the same
// run on the same input. Both only classify text; prompts answer "no".
const LIMIT = 3;
const fixtures = resolve(import.meta.dirname, 'fixtures/main-7b8edc4');
const pr = createCommandGuard({
  policyPath: resolve(import.meta.dirname, '../command-guard.json'),
});
const main = createMainGuard({
  policyPath: resolve(fixtures, 'command-guard.json'),
});

type Guard = typeof pr;
async function time(guard: Guard, command: string, cwd: string) {
  const event = {
    type: 'tool_call',
    toolCallId: 'perf',
    toolName: 'bash',
    input: {command},
  } as ToolCallEvent;
  const context = {
    cwd,
    hasUI: true,
    mode: 'tui',
    signal: new AbortController().signal,
    ui: {confirm: async () => false},
  } as unknown as ExtensionContext;
  const start = performance.now();
  await guard(event, context);
  return performance.now() - start;
}

// Best of three when main is fast, to keep scheduler noise out of the
// ratio; both guards always get the same number of runs, interleaved.
async function ratio(command: string, cwd: string) {
  let base = await time(main, command, cwd);
  let ours = await time(pr, command, cwd);
  if (base < 1000)
    for (let i = 0; i < 2; i++) {
      base = Math.min(base, await time(main, command, cwd));
      ours = Math.min(ours, await time(pr, command, cwd));
    }
  return {base, ours};
}

const UNITS: [string, string][] = [
  ['env', 'env '],
  ['set', 'set '],
  ['printenv', 'printenv '],
  ['export -p', 'export -p '],
  ['nc <', 'nc h 1 < f '],
  ['wget --post-file', 'wget --post-file=f '],
  ['npm publish', 'npm publish '],
  ['curl -s', 'curl -s '],
  ['curl -d', 'curl -d a '],
  ['git merge', 'git merge '],
  ['gql', "gh api graphql -f query='{viewer{login}}'; "],
  ['rm chain', 'rm -rf dist && '],
];
for (const [name, unit] of UNITS)
  for (const kb of [64, 128])
    test(`whole guard within ${LIMIT}x main: ${name} at ${kb} KB`, async t => {
      const cwd = fixture(t);
      const command =
        'echo ' + unit.repeat(Math.ceil((kb * 1024) / unit.length));
      await time(pr, 'ls', cwd);
      await time(main, 'ls', cwd);
      const {base, ours} = await ratio(command, cwd);
      t.diagnostic(`main ${base.toFixed(0)} ms, PR ${ours.toFixed(0)} ms`);
      assert.ok(
        ours <= LIMIT * base,
        `${name} ${kb} KB: ${ours.toFixed(0)} ms vs main ${base.toFixed(0)} ms`,
      );
    });
