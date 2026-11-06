import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {expectAll} from './helpers/verdict.ts';

// `publish` counts where a runner reads it as what to do, and in any script a
// runner or script-taker carries. Where an option may take the next word as
// its value, both readings count. Commands are only parsed, never run.

const classifierDenies = (command: string) =>
  analyzeCommand(command, import.meta.dirname).decisions.some(decision =>
    /package publish/u.test(decision.reason),
  );

test('round 3: runner options with values do not hide a publish', async () => {
  await expectAll(
    [
      "npx --proxy http://x -c 'npm publish'",
      "npm exec --depth 1 -c 'npm publish'",
      "npx -C /x -c 'npm publish'",
      "npx -w a -c 'npm publish'",
      "npx --omit dev --call='npm publish'",
      "npx --https-proxy http://x -c 'npm publish'",
      "npx --before 2020-01-01 -c 'npm publish'",
      "npx --cafile /x -c 'npm publish'",
      "npx --globalconfig /x -c 'npm publish'",
      "npx --script-shell /bin/sh -c 'npm publish'",
      "npx --user-agent ua -c 'npm publish'",
      "npx --include dev -c 'npm publish'",
      "npx --workspace a -c 'npm publish'",
      "npm x --proxy http://x -c 'npm publish'",
      "npm x --depth 1 -c 'npm publish'",
      "npm x -C /x -c 'npm publish'",
      "npm x -w a -c 'npm publish'",
      "npm x --omit dev --call='npm publish'",
      "npx --proxy http://x --call='npm pub'",
      "npx --depth 1 -c 'lerna publish'",
    ],
    'DENY',
  );
});

test('round 3: -c, --call and exec in any position run a publish', async () => {
  await expectAll(
    [
      "npm --call='lerna publish' exec",
      "npm -c 'npm publish' exec --offline",
      "npm -c 'npm publish' x",
      "npm --call='npm publish' exec -- tsc",
      "npm -c 'npm pub' exec",
      "npm -c='npm publish' x",
      "npm --offline -c 'pnpm -r publish' exec",
    ],
    'DENY',
  );
});

test('round 3: an option that is really a flag does not hide publish', async () => {
  await expectAll(
    [
      'npm --dir publish',
      'npm --dir pub',
      'npm --dir pu',
      'yarn --tag publish',
      'yarn --access publish',
      'yarn --loglevel publish',
      'yarn --userconfig publish',
      'yarn --cache publish',
      'yarn --scope publish',
      'yarn --prefix publish',
      'yarn --dir publish',
      'yarn --new-version publish',
      'npm --tag publish',
      'npm --access publish',
      'pnpm --dir publish',
      'lerna --scope publish',
    ],
    'DENY',
  );
});

test('a quoted script after a runner, and unreadable options, still count', () => {
  for (const command of [
    'npm --registry=x -h publish',
    'npm --foo=1 -v publish',
    "npm exec -- tsc --call='lerna publish'",
    "npx tsc --call='lerna publish'",
    "npx tsc -c 'lerna publish'",
    'pnpm exec echo "npm publish"',
    "pnpm exec printf '%s\\n' 'example; lerna publish'",
    'npx cowsay "npm publish"',
    'npm -d -v publish',
    'npm -ddd -v publish',
    'npm -- publish',
    'npm run -- publish',
    'npm run publish:npm',
    'pnpm --dir publish',
    'pnpm -r exec npm publish',
    'yarn workspaces foreach -A run publish',
  ]) {
    assert.equal(classifierDenies(command), true, command);
  }
});

test('publish as a package name, filter, option value or after -- is not a publish', () => {
  for (const command of [
    'npm install publish',
    'npm i -D publish',
    'npm view publish version',
    'pnpm add publish',
    'yarn add publish',
    'npm run test -- publish',
    'npm test -- --test-name-pattern publish',
    'npm run test -- -t publish',
    'npm -w pkg test -- publish',
    'npm run build -- --outDir pub',
    'pnpm --filter publish test',
    'pnpm -r --filter publish run test',
    'pnpm test --filter publish',
    'pnpm vitest run publish',
    'npx vitest publish',
    'npm exec vitest publish',
    'pnpm dlx vitest publish',
    'yarn dlx vitest publish',
    'yarn workspace publish build',
    'yarn npm info publish',
    'lerna run test --scope publish',
  ]) {
    assert.equal(classifierDenies(command), false, command);
  }
});

test('round 3: help and version output is allowed', () => {
  for (const command of [
    'npm help publish',
    'npm -h publish',
    'npm --help publish',
    'npm -v publish',
    'npm --version publish',
  ]) {
    assert.equal(classifierDenies(command), false, command);
  }
});

test('VS Code extension and JSR publishing CLIs are publishes', () => {
  for (const command of [
    'npx vsce publish',
    'vsce publish',
    'npx @vscode/vsce publish',
    'pnpm dlx @vscode/vsce publish --pat x',
    'npx ovsx publish',
    'npx jsr publish',
    'npm run release:publish',
  ])
    assert.equal(classifierDenies(command), true, command);
  for (const command of ['npx vsce package', 'vsce ls', 'npx jsr add @std/fs'])
    assert.equal(classifierDenies(command), false, command);
});
