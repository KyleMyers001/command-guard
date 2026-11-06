import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {decide} from './helpers/decide.ts';

// EL-115, PR 4, commit 4 (Codex 4460541397, CR finding 4): shell keywords and
// the wrappers `env`, `time` and assignments alternate before a command, and
// all of them are removed: `time ! X` runs X.

const cwd = process.cwd();
const views = (command: string) => analyzeCommand(command, cwd).invocations;
const PUBLISH = 'viewpm -r publish';
const RULE = `BashCmdRegex(^${PUBLISH})`;

const before = [
  'time !',
  'time -p !',
  'time -l !',
  'FOO=1 time !',
  'env time !',
  'env -i time -p !',
  'env FOO=1 time !',
  'time time !',
  '! time',
  '! time !',
  'time ! time !',
  'time ! FOO=1',
  'time ! env -u X',
  '! ! time ! env',
  'time ! { time !',
  'time ! if time ! then',
  '{fd}>f time ! >g',
  'time ! time -p ! FOO=1 env time ! !',
];

test('keywords and wrappers are removed in any order', async t => {
  for (const prefix of before) {
    const command = `${prefix} ${PUBLISH}`;
    assert.ok(views(command)?.includes(PUBLISH), command);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', command);
    assert.equal(await decide(t, {ask: [RULE]}, command), 'ASK', command);
  }
});

test('a script run after such a prefix is read', async t => {
  for (const prefix of before) {
    for (const runner of ['bash -c', 'sh -c', 'eval']) {
      const command = `${prefix} ${runner} "echo ok; ${PUBLISH}"`;
      assert.ok(views(command)?.includes(PUBLISH), command);
      assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', command);
    }
  }
});

test('a function body after a prefix is read', () => {
  for (const command of [
    `time ! function f { ${PUBLISH}; }`,
    `FOO=1 time function f { ${PUBLISH}; }`,
    `! time { ${PUBLISH}; }`,
  ]) {
    assert.ok(views(command)?.includes(PUBLISH), command);
  }
});

test('what follows the prefix decides, not the prefix', async t => {
  for (const command of [
    'time ! viewpm -r build',
    'time -p ! echo viewpm -r publish',
    'FOO=1 time ! git status',
    'env time ! bash -c "echo ok"',
  ]) {
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
  }
});

test('a prefix with nothing after it is no command', () => {
  for (const command of ['time !', 'time ! time', '! !', 'env time !']) {
    assert.deepEqual(views(command), [], command);
  }
});

test('an unknown option still opens the command, as before', () => {
  const found = views(`env -S x time ! ${PUBLISH}`);
  assert.ok(found?.includes(PUBLISH));
});
