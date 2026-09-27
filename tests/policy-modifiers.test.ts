import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {loadPolicy} from '../extensions/command-guard/policy.ts';

function regex(t: TestContext, source: string) {
  const root = fixture(t);
  const path = join(root, 'policy.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      permissions: {deny: [`BashRegex(${source})`], ask: []},
    }),
  );
  const compiled = loadPolicy(path).deny[0].regex;
  assert.ok(compiled);
  return compiled;
}

test('whole-expression m compiles portably before the constructor', t => {
  const compiled = regex(t, '(?m:^pass\\s+example$)');
  assert.equal(compiled.flags, 'mu');
  for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.equal(
        compiled.test(`harmless${separator}pass\texample${separator}done`),
        true,
      );
      assert.equal(compiled.test('echo pass example'), false);
    }
  }
});

test('existing i and unmodified expressions keep their matching scope', t => {
  const insensitive = regex(t, '(?i:^drop\\s+table$)');
  assert.equal(insensitive.flags, 'iu');
  assert.equal(insensitive.test('Drop Table'), true);
  assert.equal(insensitive.test('harmless\nDrop Table'), false);
  const ordinary = regex(t, '^pass\\s+example$');
  assert.equal(ordinary.flags, 'u');
  assert.equal(ordinary.test('harmless\npass example'), false);
  assert.equal(ordinary.test('PASS example'), false);
});

test('whole-expression im explicitly combines both supported modifiers', t => {
  const compiled = regex(t, '(?im:^drop\\s+table$)');
  assert.equal(compiled.flags, 'imu');
  assert.equal(compiled.test('harmless\nDrop Table\ndone'), true);
});

test('non-whole modifiers retain the native runtime behavior', t => {
  const source = '(?i:drop)( table)';
  let native: RegExp;
  try {
    native = new RegExp(source, 'u');
  } catch {
    assert.throws(() => regex(t, source), /configuration error/);
    return;
  }
  const compiled = regex(t, source);
  for (const text of ['Drop table', 'Drop TABLE', 'drop table']) {
    assert.equal(compiled.test(text), native.test(text));
  }
});

test('malformed whole-expression modifiers fail with sanitized policy errors', t => {
  for (const source of [
    '(?m:[private-unclosed)',
    '(?m:private-unclosed',
    '(?im:private))',
  ]) {
    assert.throws(
      () => regex(t, source),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /configuration error/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
  }
});
