import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadPolicy} from '../extensions/command-guard/policy.ts';
import {matches} from '../extensions/command-guard/match.ts';

const evidence = join(homedir(), 'Workbench/Investigations/pi-extension-tests');
mkdirSync(evidence, {recursive: true});
const root = mkdtempSync(join(evidence, 'raw-'));
function rule(selector: unknown) {
  const path = join(root, 'policy.json');
  writeFileSync(
    path,
    JSON.stringify({version: 1, permissions: {deny: [selector], ask: []}}),
  );
  return loadPolicy(path).deny[0];
}

test('BashRawRegex matches raw and canonical but never flattened spellings', () => {
  for (const selector of ['BashRawRegex', 'BashRegex']) {
    const compiled = rule(`${selector}((?m:>\\s*/dev/disk))`);
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
  const canonical = rule('BashRawRegex(^gh auth token$)');
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
      rule('BashRawRegex((?im:^fixture$))'),
      'bash',
      ['other\nFIXTURE', 'other'],
      root,
      root,
    ),
    true,
  );
});

test('raw selector keeps strict string syntax and sanitized regex errors', () => {
  for (const selector of [
    'BashRawRegex',
    'BashRawRegex()',
    'BashRawRegex([private)',
    'BashRawRegex(a\0b)',
    'BashRaw(*)',
    {selector: 'BashRegex(x)', flatten: false},
  ]) {
    assert.throws(
      () => rule(selector),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /configuration error/);
        assert.doesNotMatch(error.message, /private/);
        return true;
      },
    );
  }
});
