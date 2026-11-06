import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {decide} from './helpers/decide.ts';

// EL-115, PR 4, commit 3 (QA P14-F2): a redirection written before the command
// or among its words is no part of it, a named descriptor (`{fd}>file`)
// included.

const cwd = process.cwd();
const views = (command: string) => analyzeCommand(command, cwd).invocations;
const PUBLISH = 'viewpm -r publish';
const RULE = `BashCmdRegex(^${PUBLISH})`;

const redirects = [
  '{fd}>f',
  '{fd}<f',
  '{out}>>f',
  '{fd}>&2',
  '{fd}>&-',
  '{a}<f {b}>g',
  '>f',
  '>>f',
  '>|f',
  '<f',
  '2>&1',
  '2>f',
  '&>f',
  '<<<word',
  '>f 2>&1 <g',
  '{fd}>f 2>&1',
];

test('redirections before the command are not part of it', async t => {
  for (const redirect of redirects) {
    const command = `${redirect} ${PUBLISH}`;
    assert.ok(views(command)?.includes(PUBLISH), command);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', command);
    assert.equal(await decide(t, {ask: [RULE]}, command), 'ASK', command);
  }
});

test('a named descriptor among the arguments is not one', () => {
  for (const command of [
    'viewpm {fd}>f -r publish',
    'viewpm -r {fd}<f publish',
    'viewpm -r publish {fd}>f',
    `FOO=1 {fd}>f ${PUBLISH}`,
    `if true; then {fd}>f ${PUBLISH}; fi`,
    `time {fd}>f ${PUBLISH}`,
  ]) {
    assert.ok(views(command)?.includes(PUBLISH), command);
  }
});

test('a script run after a redirection is read', async t => {
  for (const redirect of ['{fd}>f', '>f', '2>&1', '{a}<f {b}>g']) {
    const command = `${redirect} bash -c "echo ok; ${PUBLISH}"`;
    assert.ok(views(command)?.includes(PUBLISH), command);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', command);
  }
});

test('a redirection does not make another command a publish', async t => {
  for (const command of [
    '{fd}>f echo viewpm -r publish',
    '>f viewpm -r build',
    '{fd}>viewpm -r publish',
    'echo {fd}>f; viewpm -r build',
  ]) {
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
  }
});

test('other brace words stay as written', () => {
  assert.deepEqual(views('echo {a,b} {} {1} {a-b}'), [
    "echo '{a,b}' '{}' '{1}' '{a-b}'",
  ]);
});
