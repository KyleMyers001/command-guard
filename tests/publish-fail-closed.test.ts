import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {expectAll} from './helpers/verdict.ts';

// EL-115 / PR 5, round 3. The classifier does not read option grammar: any
// `publish` word of an npm, pnpm, yarn, npx, lerna or changesets command, or
// inside a script it carries, is denied. Commands are only parsed, never run.

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

test('round 3: any publish word of these tools is denied, whatever the options (accepted over-blocks)', () => {
  for (const command of [
    'npm install publish',
    'npm run test -- publish',
    'npm view publish version',
    'npm --registry=x -h publish',
    'npm --foo=1 -v publish',
    "npm exec -- tsc --call='lerna publish'",
    "npx tsc --call='lerna publish'",
    "npx tsc -c 'lerna publish'",
    'pnpm exec echo "npm publish"',
    "pnpm exec printf '%s\\n' 'example; lerna publish'",
    'pnpm add publish',
    'npx cowsay "npm publish"',
    'yarn add publish',
    'npm -d -v publish',
    'npm -ddd -v publish',
  ]) {
    assert.equal(classifierDenies(command), true, command);
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
