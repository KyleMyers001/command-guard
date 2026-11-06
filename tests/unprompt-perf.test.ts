import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import type {
  ExtensionContext,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import {createCommandGuard} from '../extensions/command-guard.ts';
import {fixture} from './helpers/fixtures.ts';

// Pathological repeats must not make the whole guard blow up. Each shape is
// timed at 8 KB and at 32 KB, four times the input. Main itself is quadratic
// on some of these (curl -s takes about 1 s at 32 KB), so quadratic growth,
// 16x, passes with room for noise; cubic growth, 64x, fails. A generous
// absolute budget catches a slowdown that scales well but starts high. The
// test compares the guard with itself, so a slow CI machine does not fail it.
// Commands are only classified; prompts answer "no".
const GROWTH = 32;
// Below this a run is mostly timer and scheduler noise.
const FLOOR_MS = 10;
const BUDGET_MS = 15_000;

const guard = createCommandGuard({
  policyPath: resolve(import.meta.dirname, '../command-guard.json'),
  env: {},
  curlrcRisky: () => false,
});

async function time(command: string, cwd: string): Promise<number> {
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

// The fastest of three runs, or of one when a run takes over a second.
async function best(command: string, cwd: string): Promise<number> {
  let fastest = await time(command, cwd);
  for (let i = 0; i < 2 && fastest < 1000; i++)
    fastest = Math.min(fastest, await time(command, cwd));
  return fastest;
}

async function expectScales(
  name: string,
  build: (bytes: number) => string,
  cwd: string,
): Promise<string> {
  await time('ls', cwd);
  const small = await best(build(8 * 1024), cwd);
  const large = await best(build(32 * 1024), cwd);
  const growth = large / Math.max(small, FLOOR_MS);
  assert.ok(
    growth <= GROWTH,
    `${name}: ${small.toFixed(0)} ms at 8 KB, ${large.toFixed(0)} ms at 32 KB`,
  );
  assert.ok(large < BUDGET_MS, `${name}: ${large.toFixed(0)} ms at 32 KB`);
  return `${name}: ${small.toFixed(0)} ms at 8 KB, ${large.toFixed(0)} ms at 32 KB`;
}

const repeat = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length));

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
  test(`whole guard scales on repeated ${name}`, async t => {
    const cwd = fixture(t);
    t.diagnostic(
      await expectScales(name, bytes => 'echo ' + repeat(unit, bytes), cwd),
    );
  });

// A safe-list reader after an exempt command once took quadratic time
// because each accepted flag copied the rest of the arguments. Each shape is
// `git config user.name; <reader> <flags>` repeated.
const SAFE_READER_SHAPES: [string, string, string][] = [
  ['sort', 'sort ', '-r '],
  ['wc', 'wc ', '-l '],
  ['grep', 'grep ', '-i '],
  ['ls', 'ls ', '-l '],
  ['head', 'head -n 1 ', 'f '],
  ['tail', 'tail -n 1 ', 'f '],
  ['cat', 'cat ', 'f '],
  ['jq', 'jq . ', 'f '],
  ['git status', 'git status ', '-s '],
  ['git log', 'git log ', '--oneline '],
  ['git log -n', 'git log ', '-n 1 '],
];
for (const [name, head, unit] of SAFE_READER_SHAPES)
  test(`whole guard scales on safe list ${name}`, async t => {
    const cwd = fixture(t);
    const tail = name === 'grep' ? 'x' : '';
    t.diagnostic(
      await expectScales(
        `safe list ${name}`,
        bytes => 'git config user.name; ' + head + repeat(unit, bytes) + tail,
        cwd,
      ),
    );
  });
