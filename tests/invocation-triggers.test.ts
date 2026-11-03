import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {matches} from '../extensions/command-guard/match.ts';
import {
  regexTriggers,
  triggerMatchers,
} from '../extensions/command-guard/triggers.ts';
import {decide} from './helpers/decide.ts';
import {padding} from './helpers/obfuscation.ts';
import {rule} from './helpers/policy-rule.ts';

// EL-115, PR 4, fix: trigger words follow the rule's own case folding, the
// derivation is linear in the size of the expression, and its limits hold.

const cwd = process.cwd();
const pad = padding(1100);
const kinds = [
  ['deny', 'DENY'],
  ['ask', 'ASK'],
] as const;

test('a trigger is found as the rule’s regex finds it, with or without a view', async t => {
  const insensitive = 'BashCmdRegex((?i:^pnpm -r .*publish))';
  const sensitive = 'BashCmdRegex(^pnpm -r publish)';
  // Under `iu`, `ſ` (long s) is an `s`.
  const cases = [
    [insensitive, 'sudo pnpm -r publiſh', true],
    [insensitive, 'sudo PNPM -R PUBLISH', true],
    [insensitive, 'sudo pnpm -r build', false],
    [sensitive, 'sudo pnpm -r publish', true],
    [sensitive, 'sudo PNPM -r PUBLISH', false],
    [sensitive, 'sudo pnpm -r publiſh', false],
  ] as const;
  for (const [selector, command, blocked] of cases) {
    const padded = `${command}\necho ${pad}`;
    assert.ok(analyzeCommand(command, cwd).invocations, command);
    assert.equal(analyzeCommand(padded, cwd).invocations, undefined, command);
    for (const [kind, blockedAs] of kinds) {
      const expected = blocked ? blockedAs : 'ALLOW';
      const rules = {[kind]: [selector]};
      assert.equal(await decide(t, rules, command), expected, command);
      assert.equal(await decide(t, rules, padded), expected, padded);
    }
  }
});

test('matchers fold case as the expression does', () => {
  const sensitive = triggerMatchers('^pnpm -r publish') ?? [];
  const insensitive = triggerMatchers('(?i:^pnpm -r publish)') ?? [];
  assert.deepEqual(
    sensitive[0].map(word => word.flags),
    ['u', 'u', 'u'],
  );
  assert.deepEqual(
    insensitive[0].map(word => word.flags),
    ['iu', 'iu', 'iu'],
  );
  assert.ok(insensitive[0][2].test('PUBLISH'));
  assert.ok(insensitive[0][2].test('publiſh'));
  assert.ok(!sensitive[0][2].test('publiſh'));
  // A group that is only grouping is not a modifier.
  const grouped = triggerMatchers('^(?:npm|pnpm) publish') ?? [];
  assert.equal(grouped[0][0].flags, 'u');
  // Words with regex syntax in them are matched as text.
  assert.ok(triggerMatchers('^a\\.b\\+c d')?.[0][0].test('xa.b+c'));
  assert.ok(!triggerMatchers('^a\\.b\\+c d')?.[0][0].test('xaXb+c'));
});

test('a rule is evaluated once for no view, whatever its size', () => {
  const alternatives = (n: number, prefix = '') =>
    Array.from({length: n}, (_, i) => `${prefix}pnpm -r p${i}`).join('|');
  for (const [count, limit] of [
    [50_000, 1500],
    [200_000, 3000],
  ]) {
    const top = `^${alternatives(count, '^')}`.replace('^^', '^');
    const grouped = `^pnpm (?:${alternatives(count).replaceAll('pnpm -r ', 'w')}) publish`;
    for (const source of [top, grouped]) {
      const start = performance.now();
      const triggers = regexTriggers(source);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < limit, `${count}: ${elapsed.toFixed(0)}ms`);
      // Too many alternatives name nothing: fail closed. A group of them is
      // left out and the rest of the expression still names its words.
      assert.deepEqual(
        triggers,
        source === top ? undefined : [['pnpm', 'publish']],
      );
    }
  }
});

test('a rule with too many alternatives matches any command with no view', t => {
  const source = `^${Array.from({length: 50_000}, (_, i) => `pnpm -r p${i}`).join('|^')}`;
  const start = performance.now();
  const compiled = rule(t, `BashCmdRegex(${source})`);
  assert.ok(performance.now() - start < 3000);
  assert.equal(compiled.triggers, undefined);
  assert.equal(matches(compiled, 'bash', ['echo hi'], cwd, cwd), true);
  assert.equal(
    matches(compiled, 'bash', ['echo hi'], cwd, cwd, ['echo hi']),
    false,
  );
});

test('a deep or malformed expression fails closed', () => {
  assert.equal(regexTriggers(`${'('.repeat(200_000)}pnpm publish`), undefined);
  assert.equal(regexTriggers('^(pnpm publish'), undefined);
});
