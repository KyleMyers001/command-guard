import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {MAX_TARGET_ENTRIES} from '../extensions/command-guard/exemptions.ts';
import {fixture} from './helpers/fixtures.ts';
import {verdict, type Verdict} from './helpers/verdict.ts';

// An `rm -r` of a build directory skips the prompt only when no repository
// lives at its root or one level down. Fixtures are synthetic directories
// under a temp dir; commands are only classified, never run.

function layout(root: string, paths: Record<string, 'dir' | 'file'>): void {
  for (const [path, kind] of Object.entries(paths)) {
    const full = join(root, path);
    if (kind === 'dir') mkdirSync(full, {recursive: true});
    else {
      mkdirSync(join(full, '..'), {recursive: true});
      writeFileSync(full, 'gitdir: elsewhere\n');
    }
  }
}

async function expectIn(
  cwd: string,
  rows: [command: string, expected: Verdict][],
): Promise<void> {
  const wrong: string[] = [];
  for (const [command, expected] of rows) {
    const actual = await verdict(command, cwd);
    if (actual !== expected) wrong.push(`${command}: ${actual}`);
  }
  assert.deepEqual(wrong, []);
}

test('a build directory holding a repository keeps the ask', async t => {
  const cwd = fixture(t);
  layout(cwd, {
    'build/.git': 'dir',
    'out/.git': 'file',
    'target/sub/.git': 'dir',
    'coverage/sub/.git': 'file',
    'dist/index.js': 'file',
  });
  await expectIn(cwd, [
    ['rm -rf build', 'ASK'],
    ['rm -rf ./build', 'ASK'],
    ['rm -rf out', 'ASK'],
    ['rm -rf target', 'ASK'],
    ['rm -rf coverage', 'ASK'],
    ['rm -rf dist build', 'ASK'],
    ['rm -rf dist && rm -rf target', 'ASK'],
    ['npm run build && rm -rf build', 'ASK'],
    ['rm -rf dist', 'ALLOW'],
  ]);
});

test('a plain, missing, symlinked or file target stays exempt', async t => {
  const cwd = fixture(t);
  layout(cwd, {
    'build/lib/index.js': 'file',
    'build/assets/logo.svg': 'file',
    'repo/.git': 'dir',
    // Below the immediate children: not read (documented depth limit).
    'out/a/b/.git': 'dir',
    'coverage/.gitkeep': 'file',
    'target/tools/.github': 'dir',
  });
  writeFileSync(join(cwd, 'node_modules'), 'a file, not a directory\n');
  // `rm -rf dist` without a trailing slash removes only the link.
  symlinkSync(join(cwd, 'repo'), join(cwd, 'dist'));
  // A symlinked child directory is not entered.
  symlinkSync(join(cwd, 'repo'), join(cwd, 'build', 'linked'));
  await expectIn(cwd, [
    ['rm -rf build', 'ALLOW'],
    ['rm -rf .next', 'ALLOW'],
    ['rm -rf dist', 'ALLOW'],
    ['rm -rf out', 'ALLOW'],
    ['rm -rf coverage', 'ALLOW'],
    ['rm -rf target', 'ALLOW'],
    ['rm -rf node_modules', 'ALLOW'],
    ['rm -rf dist build out .next && npm run build', 'ALLOW'],
  ]);
});

test('a directory change before the removal keeps the ask', async t => {
  const cwd = fixture(t);
  layout(cwd, {'x/build/lib/index.js': 'file', 'build/index.js': 'file'});
  await expectIn(cwd, [
    ['cd x && rm -rf build', 'ASK'],
    ['cd x; rm -rf build', 'ASK'],
    ['pushd x && rm -rf build', 'ASK'],
    ['rm -rf build', 'ALLOW'],
  ]);
});

test('more top-level entries than the cap keeps the ask', async t => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, 'node_modules'));
  mkdirSync(join(cwd, 'dist'));
  for (let i = 0; i < MAX_TARGET_ENTRIES; i++) {
    writeFileSync(join(cwd, 'node_modules', `p${i}`), '');
    writeFileSync(join(cwd, 'dist', `p${i}`), '');
  }
  writeFileSync(join(cwd, 'node_modules', 'one-more'), '');
  await expectIn(cwd, [
    ['rm -rf dist', 'ALLOW'],
    ['rm -rf node_modules', 'ASK'],
  ]);
});

test('a target that cannot be read keeps the ask', async t => {
  if (process.getuid?.() === 0) return t.skip('root reads any directory');
  const cwd = fixture(t);
  mkdirSync(join(cwd, 'build'));
  chmodSync(join(cwd, 'build'), 0o000);
  try {
    await expectIn(cwd, [['rm -rf build', 'ASK']]);
  } finally {
    chmodSync(join(cwd, 'build'), 0o755);
  }
});
