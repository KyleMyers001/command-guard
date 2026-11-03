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

test('raw rules read each canonical line, never across commands', t => {
  const root = fixture(t);
  const lines = ['git push origin feat/x', 'rm -f y'];
  const command = texts(
    'git push origin feat/x\nrm -f y',
    lines.join('\n'),
    lines,
  );
  const spanning = rule(t, 'BashRawRegex(push[\\s\\S]*-f)');
  const perLine = rule(t, 'BashRawRegex(^rm -f y$)');
  const flattened = rule(t, 'BashRegex(push[\\s\\S]*-f)');
  // The raw text still spans lines; the canonical lines do not.
  assert.equal(matches(spanning, 'bash', command, root, root), true);
  assert.equal(
    matches(spanning, 'bash', {...command, raw: 'ls'}, root, root),
    false,
  );
  assert.equal(
    matches(perLine, 'bash', {...command, raw: 'ls'}, root, root),
    true,
  );
  assert.equal(matches(flattened, 'bash', command, root, root), true);
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
