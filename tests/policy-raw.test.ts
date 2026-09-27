import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/fixtures.ts';
import {rule} from './helpers/policy-rule.ts';
import {matches} from '../extensions/command-guard/match.ts';

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
          ['printf fixture > /dev/disk9', 'printf fixture'],
          root,
          root,
        ),
        true,
      );
      assert.equal(
        matches(
          compiled,
          'bash',
          ['printf fixture >\\\n/dev/disk9', 'printf fixture'],
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
      ['/opt/bin/gh auth token', 'gh auth token'],
      root,
      root,
    ),
    true,
  );
  assert.equal(
    matches(
      rule(t, 'BashRawRegex((?im:^fixture$))'),
      'bash',
      ['other\nFIXTURE', 'other'],
      root,
      root,
    ),
    true,
  );
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
