import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {rule} from './helpers/policy-rule.ts';
import {matches} from '../extensions/command-guard/match.ts';

// Texts for a command with no separate lines: raw rules read the canonical text.
const texts = (raw: string, canonical: string, lines: string[] = []) => ({
  raw,
  canonical,
  lines,
});

test('BashRawRegex matches raw and canonical but never flattened spellings', t => {
  const root = fixture(t);
  for (const selector of ['BashRawRegex', 'BashRegex']) {
    const compiled = rule(t, `${selector}((?m:>\\s*/dev/disk))`);
    assert.equal(compiled.regex?.flags, 'mu');
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.equal(
        matches(
          compiled,
          'bash',
          texts('printf fixture > /dev/disk9', 'printf fixture'),
          root,
          root,
        ),
        true,
      );
      assert.equal(
        matches(
          compiled,
          'bash',
          texts('printf fixture >\\\n/dev/disk9', 'printf fixture'),
          root,
          root,
        ),
        selector === 'BashRegex',
      );
    }
  }
  const canonical = rule(t, 'BashRawRegex(^gh auth token$)');
  assert.equal(
    matches(
      canonical,
      'bash',
      texts('/opt/bin/gh auth token', 'gh auth token'),
      root,
      root,
    ),
    true,
  );
  assert.equal(
    matches(
      rule(t, 'BashRawRegex((?im:^fixture$))'),
      'bash',
      texts('other\nFIXTURE', 'other'),
      root,
      root,
    ),
    true,
  );
});

test('raw rules read the raw text, the canonical text and each line', t => {
  const root = fixture(t);
  const lines = ['git push origin feat/x', 'rm -f y'];
  const command = texts(
    'git push origin feat/x && rm -f y',
    lines.join('\n'),
    lines,
  );
  const hit = (selector: string, over: Partial<typeof command> = {}) =>
    matches(rule(t, selector), 'bash', {...command, ...over}, root, root);

  // Each line on its own, so a line anchor works without the raw text.
  assert.equal(hit('BashRawRegex(^rm -f y$)'), true);
  // The joined canonical text still spans lines, as it did before lines existed.
  assert.equal(hit('BashRawRegex(push[\\s\\S]*-f)', {raw: 'ls'}), true);
  // The raw text is read as written.
  assert.equal(hit('BashRawRegex(&& rm)'), true);
  // Flattened spellings stay out of raw rules, and are in for plain regexes.
  const continued = {
    raw: 'rm \\\n-f y',
    canonical: 'rm -f y',
    lines: ['rm -f y'],
  };
  assert.equal(hit('BashRawRegex(^rm -f y$)', {raw: continued.raw}), true);
  assert.equal(
    hit('BashRawRegex(rm -f)', {raw: 'x', canonical: 'rm \\\n-f', lines: []}),
    false,
  );
  assert.equal(
    hit('BashRegex(rm -f)', {raw: 'x', canonical: 'rm \\\n-f', lines: []}),
    true,
  );
  // Nothing to match: no line, canonical or raw text contains it.
  assert.equal(hit('BashRawRegex(absent)'), false);
});

test('raw selector keeps strict string syntax and sanitized regex errors', t => {
  for (const selector of [
    'BashRawRegex',
    'BashRawRegex()',
    'BashRawRegex([private)',
    'BashRawRegex(a\0b)',
    'BashRaw(*)',
    {selector: 'BashRegex(x)', flatten: false},
  ]) {
    assert.throws(
      () => rule(t, selector),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /configuration error/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
  }
});
