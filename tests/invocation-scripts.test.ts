import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {decide} from './helpers/decide.ts';

// EL-115, PR 4, commit 2 (QA P14-F1): a literal `sh -c`, `bash -c` or `eval`
// script is read by the view where it is the command: after a shell keyword,
// or in a function body, not only at the start of a segment.

const cwd = process.cwd();
const views = (command: string) => analyzeCommand(command, cwd).invocations;
const PUBLISH = 'viewpm -r publish';
const RULE = `BashCmdRegex(^${PUBLISH})`;

// `script` hides the publish behind an `echo`, so no spelling of the script
// itself (as a word, or as a tail of an open command) can match.
const script = `"echo ok; ${PUBLISH}"`;
const hidden = {
  brace: `{ bash -c ${script}; }`,
  if: `if true; then bash -c ${script}; fi`,
  ifCondition: `if bash -c ${script}; then :; fi`,
  elif: `if false; then :; elif sh -c ${script}; then :; fi`,
  while: `while sh -c ${script}; do :; done`,
  until: `until eval ${script}; do :; done`,
  for: `for i in 1 2; do bash -c ${script}; done`,
  select: `select x in a; do eval ${script}; done`,
  not: `! bash -c ${script}`,
  notBrace: `! { zsh -c ${script}; }`,
  function: `f() { bash -c ${script}; }; f`,
  functionKeyword: `function f { bash -c ${script}; }; f`,
  functionBody: `function f { eval ${script}; }`,
  nested: `if x; then bash -c "if y; then sh -c 'echo; ${PUBLISH}'; fi"; fi`,
};

test('a script after a keyword or in a function body is read', () => {
  for (const [name, command] of Object.entries(hidden)) {
    assert.ok(views(command)?.includes(PUBLISH), name);
  }
});

test('the commands of such a script are blocked by a deny and an ask rule', async t => {
  for (const [name, command] of Object.entries(hidden)) {
    assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', name);
    assert.equal(await decide(t, {ask: [RULE]}, command), 'ASK', name);
  }
});

test('a script that does not publish is not blocked', async t => {
  for (const command of [
    'if true; then bash -c "echo viewpm -r build"; fi',
    'f() { bash -c "echo a; echo viewpm -r publish"; }; f',
    '! eval "echo ok"',
    'function f { echo viewpm -r publish; }',
  ]) {
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
  }
});

test('a computed script after a keyword has no view; the guard decides as before', async t => {
  for (const command of [
    'if true; then bash -c "$X"; fi',
    '{ eval "$X"; }',
    'while sh -c "echo $Y"; do :; done',
  ]) {
    assert.equal(views(command), undefined, command);
    // No new decision of the guard's own: only a rule that names the words
    // can block it.
    assert.deepEqual(analyzeCommand(command, cwd).decisions, [], command);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
    assert.equal(
      await decide(t, {deny: [RULE]}, `${command}; ${PUBLISH}`),
      'DENY',
      command,
    );
  }
});

test('a keyword and a function name alone make no view of a script', () => {
  assert.deepEqual(views('function f { echo; }'), ['echo', '}']);
  assert.deepEqual(views('if true; then echo hi; fi'), [
    'true',
    'echo hi',
    'fi',
  ]);
  assert.ok(!views('function bash { echo; }')?.includes('echo ok'));
});
