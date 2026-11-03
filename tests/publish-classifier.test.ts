import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {expectAll} from './helpers/verdict.ts';

// EL-115 / PR 5. Commands are only parsed, never executed.

const analysis = (command: string) =>
  analyzeCommand(command, import.meta.dirname).decisions;
const classifierDenies = (command: string) =>
  analysis(command).some(decision => /package publish/u.test(decision.reason));

test('denies publish through every npm, pnpm and yarn spelling', async () => {
  await expectAll(
    [
      'npm publish',
      'npm publish --dry-run',
      'npm --workspaces publish',
      'npm -ws publish',
      'npm -w pkg publish',
      'npm -w pkg -w other publish',
      'npm --workspace pkg publish',
      'npm --workspace=pkg publish',
      'npm --prefix packages/a publish',
      'npm --registry https://r.invalid publish --access public',
      'npm pu',
      'npm pub --tag next',
      'npm publis',
      'npm run publish',
      'npm run-script publish',
      'npm run-s publish',
      'npm rum publish',
      'npm run -w pkg publish',
      'npm exec -- changeset publish',
      'npm exec lerna publish',
      'pnpm publish',
      'pnpm -r publish',
      'pnpm --recursive publish',
      'pnpm --filter pkg publish',
      'pnpm --filter=pkg publish',
      'pnpm -F pkg publish',
      'pnpm -C dir publish',
      'pnpm --dir dir -r publish',
      'pnpm -w publish',
      'pnpm --workspace-root publish',
      'pnpm recursive publish',
      'pnpm run publish',
      'pnpm exec lerna publish',
      'pnpm dlx changeset publish',
      'pnpm changeset publish',
      'yarn publish',
      'yarn --cwd pkg publish',
      'yarn npm publish',
      'yarn workspace pkg publish',
      'yarn workspace pkg npm publish',
      'yarn workspaces foreach -A npm publish',
      'yarn workspaces foreach --all --no-private npm publish',
      'yarn workspaces run publish',
      'yarn run publish',
      'yarn lerna publish',
      'yarn dlx changeset publish',
    ],
    'DENY',
  );
});

test('denies lerna and changesets publish, however they are started', async () => {
  await expectAll(
    [
      'lerna publish',
      'lerna publish from-git',
      'lerna --loglevel silly publish',
      'lerna run publish',
      'lerna exec -- npm publish',
      'changeset publish',
      'changeset publish --otp=123456',
      'npx lerna publish',
      'npx lerna@7 publish from-package',
      'npx -y changeset publish',
      'npx -p @changesets/cli changeset publish',
      'npx @changesets/cli publish',
      'npx npm@10 publish',
      './node_modules/.bin/lerna publish',
      '/usr/local/bin/npm publish',
    ],
    'DENY',
  );
});

test('denies publish behind wrappers, nesting and unknown options', async () => {
  await expectAll(
    [
      'FOO=1 pnpm -r publish',
      'env FOO=1 pnpm -r publish',
      'env -C dir pnpm -r publish',
      'time npm -w pkg publish',
      'sudo pnpm -r publish',
      'sudo -u deploy pnpm -r publish',
      'nohup yarn npm publish',
      'command pnpm -r publish',
      'exec npm --workspaces publish',
      'xargs pnpm -r publish',
      'timeout 60 npm -w pkg publish',
      'corepack pnpm -r publish',
      'bash -c "pnpm -r publish"',
      "sh -c 'npm -w pkg publish'",
      "eval 'yarn npm publish'",
      'echo ok; pnpm -r publish',
      'git status && npm --workspaces publish',
      'echo $(pnpm -r publish)',
      'npm --unknown-flag publish',
      'npm $OPTS publish',
    ],
    'DENY',
  );
});

test('the classifier, not only the text rule, denies the new forms', () => {
  for (const command of [
    'npm publish',
    'pnpm -r publish',
    'pnpm --filter pkg publish',
    'npm -w pkg publish',
    'npm --workspaces publish',
    'npm run publish',
    'lerna publish',
    'changeset publish',
  ]) {
    assert.equal(classifierDenies(command), true, command);
  }
});

test('leaves everything that is not a publish alone', () => {
  for (const command of [
    'npm install',
    'npm install publish',
    'npm i -D typescript',
    'npm ci',
    'npm test',
    'npm run build',
    'npm run publish-docs',
    'npm run test -- publish',
    'npm run build -w pkg',
    'npm view publish version',
    'npm pack',
    'npm pack --dry-run',
    'npm ls --workspaces',
    'npm -w pkg run build',
    'npm --version',
    'npm help publish',
    'npm config get registry',
    'npm exec -- tsc --noEmit',
    'pnpm install',
    'pnpm add publish',
    'pnpm -r test',
    'pnpm -r run build',
    'pnpm --filter pkg build',
    'pnpm -w install',
    'pnpm exec tsc',
    'pnpm dlx prettier --check .',
    'pnpm recursive install',
    'yarn',
    'yarn install',
    'yarn add publish',
    'yarn run build',
    'yarn workspaces foreach run build',
    'yarn workspace pkg build',
    'yarn npm whoami',
    'lerna run build',
    'lerna version',
    'lerna exec -- tsc',
    'changeset',
    'changeset add',
    'changeset version',
    'changeset status',
    'npx prettier --check .',
    'npx tsc --noEmit',
    'npx -y create-vite app',
    // Words that merely mention a publish are not a command.
    'echo npm publish',
    "rg 'a|npm publish' docs",
    'rg pnpm -r publish docs',
    'git commit -m "pnpm -r publish notes"',
    "printf 'yarn npm publish\\n'",
    'cat docs/npm-publish.md',
    'grep -r "yarn publish" .',
    'man npm-publish',
    'ls npm publish',
  ]) {
    assert.equal(classifierDenies(command), false, command);
  }
});

test('nesting too deep to inspect is denied, not skipped', () => {
  assert.equal(classifierDenies('npx npx npx npx npx npx lerna'), true);
});
