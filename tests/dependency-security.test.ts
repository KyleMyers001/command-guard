import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

// Test the installed dependency, not just package-lock.json: Pi's published
// npm-shrinkwrap.json can otherwise reinstall a vulnerable nested copy.
const cases = [
  ['GHSA-6j4f-fj2g-mc7p: comma parsing', "'{' + '{a},'.repeat(16000) + 'b}'"],
  [
    'GHSA-qhr7-859c-m2p7: nested groups',
    "'{'.repeat(3200) + 'a,b' + '}'.repeat(3200)",
  ],
  ['GHSA-q2hr-2g5m-vwhr: rewrite loop', "'{a}' + '}'.repeat(128000) + ',z}'"],
];

for (const [name, payload] of cases) {
  test(`Pi's installed brace-expansion resists ${name}`, () => {
    // A child process bounds synchronous stalls and stack exhaustion without
    // hanging the test runner. These expressions are fixed test data.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import {createRequire} from 'node:module';
          const pi = createRequire(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
          const minimatch = createRequire(pi.resolve('minimatch'));
          const {expand} = minimatch('brace-expansion');
          assert.deepEqual(expand('file{a,b}.ts'), ['filea.ts', 'fileb.ts']);
          assert.ok(Array.isArray(expand(${payload})));
        `,
      ],
      {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024},
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}
