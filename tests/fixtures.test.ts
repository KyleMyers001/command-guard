import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import type {TestContext} from 'node:test';

// Independent ownership: retention tests must not retain their outer harness.
function harness(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'command-guard-harness-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}

function childEnv(
  root: string,
  mode: string,
  keep?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: root,
    FIXTURE_MODE: mode,
  };
  // A fresh CLI test runner must not inherit its parent's worker protocol.
  delete env.NODE_TEST_CONTEXT;
  delete env.COMMAND_GUARD_KEEP_TEST_FIXTURES;
  if (keep !== undefined) env.COMMAND_GUARD_KEEP_TEST_FIXTURES = keep;
  return env;
}

function child(root: string, mode = 'success', keep?: string) {
  const env = childEnv(root, mode, keep);
  return spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      resolve(import.meta.dirname, 'helpers/lifecycle-child.ts'),
    ],
    {env, encoding: 'utf8', timeout: 30_000},
  );
}

test('successful child cleans its allocated fixture', t => {
  const root = harness(t);
  const result = child(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ALLOCATED/);
  assert.deepEqual(readdirSync(root), []);
});

test('exact retention flag keeps the owned root and prints a safe path', t => {
  const root = harness(t);
  const result = child(root, 'success', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entries = readdirSync(root);
  assert.equal(entries.length, 1);
  const retained = join(root, entries[0]);
  assert.ok(
    result.stdout.includes(
      `Retained test fixture: ${JSON.stringify(retained)}`,
    ),
  );
  assert.equal(
    readFileSync(join(retained, 'policy.json'), 'utf8'),
    'synthetic',
  );
});

test('retained path diagnostics escape terminal controls in the temp parent', t => {
  const outer = harness(t);
  const temp = join(outer, 'temp\nwith\u001bcontrols');
  mkdirSync(temp);
  const result = child(temp, 'success', '1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entries = readdirSync(temp);
  assert.equal(entries.length, 1);
  // TAP escapes the backslashes in the helper's JSON-quoted diagnostic again.
  const diagnostic = `Retained test fixture: ${JSON.stringify(join(temp, entries[0]))}`;
  assert.ok(result.stdout.includes(diagnostic.replaceAll('\\', '\\\\')));
  assert.ok(!result.stdout.includes(temp));
  assert.ok(!result.stderr.includes(temp));
});

for (const mode of ['assertion-failure', 'setup-failure']) {
  test(`${mode} cleans after allocation and preserves the failure`, t => {
    const root = harness(t);
    const result = child(root, mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      mode === 'assertion-failure' ? /original synthetic assertion/ : /EISDIR/,
    );
    assert.match(result.stdout, /ALLOCATED/);
    assert.deepEqual(readdirSync(root), []);
  });
}

for (const keep of [undefined, '1']) {
  test(`shared layout setup failure preserves the error and ${keep === '1' ? 'retains' : 'cleans'} its fixture`, t => {
    const root = harness(t);
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        resolve(import.meta.dirname, 'helpers/shared-layout-failure.ts'),
        '--test',
        '--test-reporter=tap',
        resolve(import.meta.dirname, 'command-guard-commands.test.ts'),
      ],
      {
        env: childEnv(root, 'shared-setup-failure', keep),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /EEXIST/);
    assert.match(
      result.stdout + result.stderr,
      /INJECTED shared layout setup failure/,
    );
    const entries = readdirSync(root);
    if (keep === '1') {
      assert.equal(entries.length, 1);
      const retained = join(root, entries[0]);
      assert.ok(
        (result.stdout + result.stderr).includes(
          `Retained test fixture: ${JSON.stringify(retained)}`,
        ),
      );
      assert.equal(
        readFileSync(join(retained, 'docs'), 'utf8'),
        'synthetic obstruction',
      );
    } else {
      assert.deepEqual(entries, []);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /Retained test fixture/,
      );
    }
  });
}

for (const keep of ['', '0', 'true', 'yes', '01', ' 1']) {
  test(`retention value ${JSON.stringify(keep)} still cleans`, t => {
    const root = harness(t);
    const result = child(root, 'success', keep);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Retained test fixture/);
    assert.deepEqual(readdirSync(root), []);
  });
}

test('retention also keeps an ordinary failed test fixture', t => {
  const root = harness(t);
  const result = child(root, 'assertion-failure', '1');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /original synthetic assertion/);
  assert.match(result.stdout, /Retained test fixture/);
  assert.equal(readdirSync(root).length, 1);
});

test('cleanup of an already removed owned root is harmless', t => {
  const root = harness(t);
  const result = child(root, 'already-removed');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(root), []);
});

test('cleanup unlinks nested external symlinks and loops without touching siblings', t => {
  const root = harness(t);
  mkdirSync(join(root, 'sibling'));
  writeFileSync(join(root, 'sibling/sentinel'), 'untouched');
  const result = child(root, 'symlinks');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(root), ['sibling']);
  assert.deepEqual(readdirSync(join(root, 'sibling')), ['sentinel']);
  assert.equal(
    readFileSync(join(root, 'sibling/sentinel'), 'utf8'),
    'untouched',
  );
});

for (const mode of ['cleanup-error', 'both-errors']) {
  test(`${mode} surfaces real filesystem cleanup errors without losing the assertion`, t => {
    const root = harness(t);
    const result = child(root, mode);
    // Restore only directories created by this child inside our disposable harness.
    // Do so before assertions, so even a regression cannot strand a readonly root.
    const entries = readdirSync(root);
    for (const entry of entries) chmodSync(join(root, entry), 0o700);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(entries.length, 1);
    assert.match(
      result.stdout + result.stderr,
      /Fixture cleanup failed \((?:EACCES|EPERM|ENOTEMPTY)\)/,
    );
    if (mode === 'both-errors')
      assert.match(result.stdout, /original synthetic assertion/);
  });
}

test('overlapping child runs own distinct mutable roots and cannot clean each other', async t => {
  const outer = harness(t);
  const temp = join(outer, 'temp');
  mkdirSync(temp);
  mkdirSync(join(temp, 'sibling'));
  writeFileSync(join(temp, 'sibling/sentinel'), 'untouched');
  const launch = (slot: string) =>
    promisify(execFile)(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        resolve(import.meta.dirname, 'helpers/lifecycle-child.ts'),
      ],
      {env: {...childEnv(temp, 'hold'), FIXTURE_SLOT: slot}, timeout: 15_000},
    ).then(
      result => ({ok: true, output: result.stdout + result.stderr}),
      (error: unknown) => ({ok: false, output: String(error)}),
    );
  const first = launch('a');
  const second = launch('b');
  try {
    const deadline = Date.now() + 5_000;
    while (!['a', 'b'].every(slot => existsSync(join(temp, `ready-${slot}`)))) {
      assert.ok(
        Date.now() < deadline,
        'both children must allocate before either completes',
      );
      await delay(10);
    }
    const roots = ['a', 'b'].map(slot =>
      readFileSync(join(temp, `ready-${slot}`), 'utf8'),
    );
    assert.notEqual(roots[0], roots[1]);
    for (const [index, root] of roots.entries()) {
      assert.equal(
        readFileSync(join(root, 'policy.json'), 'utf8'),
        index === 0 ? 'a' : 'b',
      );
    }
    writeFileSync(join(temp, 'release-a'), 'go');
    const a = await first;
    assert.equal(a.ok, true, a.output);
    assert.equal(existsSync(roots[0]), false);
    assert.equal(readFileSync(join(roots[1], 'policy.json'), 'utf8'), 'b');
    writeFileSync(join(temp, 'release-b'), 'go');
    const b = await second;
    assert.equal(b.ok, true, b.output);
    assert.equal(existsSync(roots[1]), false);
    assert.deepEqual(readdirSync(temp).sort(), [
      'ready-a',
      'ready-b',
      'release-a',
      'release-b',
      'sibling',
    ]);
    assert.equal(
      readFileSync(join(temp, 'sibling/sentinel'), 'utf8'),
      'untouched',
    );
  } finally {
    // Release and join children before the outer harness is torn down, even on failure.
    for (const slot of ['a', 'b'])
      writeFileSync(join(temp, `release-${slot}`), 'go');
    await Promise.all([first, second]);
  }
});

for (const suite of [
  'command-guard',
  'command-guard-commands',
  'policy-modifiers',
  'policy-raw',
]) {
  test(`${suite}: standalone suite leaves synthetic HOME unchanged and temp empty`, t => {
    const outer = harness(t);
    const home = join(outer, 'home');
    const temp = join(outer, 'temp');
    mkdirSync(temp);
    for (const dir of ['Workbench', '.pi/agent', '.claude']) {
      mkdirSync(join(home, dir), {recursive: true});
      writeFileSync(join(home, dir, 'sentinel'), `untouched ${dir}`);
    }
    const before = readdirSync(home, {recursive: true}).sort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      // Exercise the actual Pi loader without its unrelated persistent cache.
      JITI_FS_CACHE: 'false',
      PI_PACKAGE_DIR: resolve(
        import.meta.dirname,
        '../node_modules/@earendil-works/pi-coding-agent',
      ),
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.COMMAND_GUARD_KEEP_TEST_FIXTURES;
    const result = spawnSync(
      process.execPath,
      ['--test', `tests/${suite}.test.ts`],
      {
        cwd: resolve(import.meta.dirname, '..'),
        env,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(home, {recursive: true}).sort(), before);
    for (const dir of ['Workbench', '.pi/agent', '.claude']) {
      assert.equal(
        readFileSync(join(home, dir, 'sentinel'), 'utf8'),
        `untouched ${dir}`,
      );
    }
    assert.deepEqual(readdirSync(temp), []);
  });
}
