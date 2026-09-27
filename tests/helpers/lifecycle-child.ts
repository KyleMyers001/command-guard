import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {fixture} from './fixtures.ts';
import {join} from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

// Invoked explicitly by fixtures.test.ts, never by the test-file glob.
void test('synthetic lifecycle', async t => {
  const root = fixture(t);
  console.log(`ALLOCATED ${JSON.stringify(root)}`);
  const mode = process.env.FIXTURE_MODE;
  if (mode === 'setup-failure')
    writeFileSync(root, 'setup cannot write a directory');
  writeFileSync(join(root, 'policy.json'), 'synthetic');
  if (mode === 'symlinks') {
    mkdirSync(join(root, 'nested'));
    symlinkSync(join(tmpdir(), 'sibling'), join(root, 'nested/external'));
    symlinkSync(root, join(root, 'nested/loop'));
    symlinkSync(join(root, 'absent'), join(root, 'dangling'));
    assert.equal(
      readFileSync(join(root, 'nested/external/sentinel'), 'utf8'),
      'untouched',
    );
  }
  if (mode === 'hold') {
    const slot = process.env.FIXTURE_SLOT;
    assert.ok(slot === 'a' || slot === 'b');
    writeFileSync(join(root, 'policy.json'), slot);
    writeFileSync(join(tmpdir(), `ready-${slot}`), root);
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(tmpdir(), `release-${slot}`))) {
      assert.ok(Date.now() < deadline, 'parent must release held child');
      await delay(10);
    }
    assert.equal(readFileSync(join(root, 'policy.json'), 'utf8'), slot);
  }
  if (mode === 'already-removed') rmSync(root, {recursive: true});
  if (mode === 'cleanup-error' || mode === 'both-errors')
    chmodSync(root, 0o500);
  if (mode === 'assertion-failure' || mode === 'both-errors')
    assert.fail('original synthetic assertion');
  assert.ok(true);
});
