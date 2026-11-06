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

test('a long sequence keeps its first 32 words and takes under a second', () => {
  const n = 50_000;
  const named = (i: number) => `a${i}`;
  const sources = {
    'a0.a1.… with a wildcard between': `^${Array.from({length: n}, (_, i) => named(i)).join('.')}`,
    'single-alternative groups': `^${Array.from({length: n}, (_, i) => `(${named(i)})`).join('')}`,
    'non-capturing groups': `^${Array.from({length: n}, (_, i) => `(?:${named(i)})`).join(' ')}`,
  };
  const first = Array.from({length: 32}, (_, i) => named(i));
  for (const [name, source] of Object.entries(sources)) {
    const start = performance.now();
    const triggers = regexTriggers(source);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `${name}: ${elapsed.toFixed(0)}ms`);
    // Fewer required words only widens the match, so the rest are left out.
    // Each space between groups is a part of its own: 32 parts, 16 words.
    const kept = name === 'non-capturing groups' ? 16 : 32;
    assert.deepEqual(triggers, [first.slice(0, kept)], name);
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

test('the limits on alternatives and on their product', () => {
  const words = (n: number) =>
    Array.from({length: n}, (_, i) => `w${i}x`).join('|');
  // At the limit of 32 the alternatives are kept; past it, none are.
  assert.equal(regexTriggers(`^(?:${words(32)})`)?.length, 32);
  assert.equal(regexTriggers(`^(?:${words(33)})`), undefined);
  assert.deepEqual(regexTriggers(`^pnpm (?:${words(33)}) publish`), [
    ['pnpm', 'publish'],
  ]);
  assert.equal(
    regexTriggers(`^${words(16)}`.replaceAll('|', '|^'))?.length,
    16,
  );
  // Two groups multiply: 4 x 8 = 32 stays whole, 4 x 9 keeps the first only.
  const group = (n: number, name: string) =>
    `(?:${Array.from({length: n}, (_, i) => `${name}${i}x`).join('|')})`;
  assert.equal(regexTriggers(`^${group(4, 'a')} ${group(8, 'b')}`)?.length, 32);
  const capped = regexTriggers(`^${group(4, 'a')} ${group(9, 'b')}`);
  assert.deepEqual(capped, [['a0x'], ['a1x'], ['a2x'], ['a3x']]);
});

test('a word boundary is not text and does not split a word', () => {
  assert.deepEqual(regexTriggers('^\\bnpm\\b publish\\b'), [
    ['npm', 'publish'],
  ]);
  assert.deepEqual(regexTriggers('^pn\\bpm -r pub\\Blish'), [
    ['pnpm', '-r', 'publish'],
  ]);
});
