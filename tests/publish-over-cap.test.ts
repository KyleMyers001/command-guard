import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';

// EL-115 / PR 5, round 6. A command over the size cap (1,000 words or 8,192
// characters) is denied when its raw text, quoted scripts included, has a
// runner name and `publish` (or `pub` after npm) anywhere. A script-taking
// word alone is not enough. Commands are only parsed, never run.

const denies = (command: string) =>
  analyzeCommand(command, import.meta.dirname).decisions.some(decision =>
    /package publish/u.test(decision.reason),
  );
const pad = ' '.repeat(8300);

test('round 6: padding a quoted script past the cap does not hide a publish', () => {
  for (const command of [
    `ssh host 'lerna publish${pad}'`,
    `ssh host 'npm publish${pad}'`,
    `npx -c 'npm pub${pad}'`,
    `su -c 'lerna publish${pad}'`,
    `runuser -u x -c 'npm publish${pad}'`,
    `flock -c 'npm publish${pad}' f`,
    `script -c 'npm publish${pad}' f`,
    `watch 'npm publish${pad}'`,
    `parallel 'npm publish${pad}'`,
    `pnpm dlx -c 'lerna publish${pad}'`,
    `pnpm exec 'lerna publish${pad}'`,
    `yarn exec 'lerna publish${pad}'`,
    `bash -c '${pad}pnpm -r publish'`,
    `eval 'npm@10 publish${pad}'`,
    `ssh host '/usr/bin/npm publish${pad}'`,
    `ssh host '@changesets/cli publish${pad}'`,
  ])
    assert.equal(denies(command), true, command.slice(0, 40));
});

test('round 6: padding with arguments past the cap does not hide a publish', () => {
  const args = 'a '.repeat(1100);
  for (const command of [
    `ssh host 'npm publish' ${args}`,
    `ssh host 'lerna publish' ${args}`,
    `npx -c 'npm pub' ${args}`,
    `${args}ssh host 'npm publish'`,
    `npm ${args}publish`,
    `pn ${args}publish`,
  ])
    assert.equal(denies(command), true, command.slice(0, 40));
});

test('round 6: a runner at the end of a script runs a publish that follows', () => {
  for (const command of [
    "ssh h 'ssh h ssh' h 'ssh h npm' publish",
    "ssh h 'a npm' publish",
    "su -c 'x lerna' publish",
  ])
    assert.equal(denies(command), true, command);
});

test('round 6: scripts nested to any depth are denied or read', () => {
  const nest = (n: number, inner: string) => {
    let script = inner;
    for (let i = 0; i < n; i++)
      script = `ssh h "${script.replace(/(["\\$`])/gu, '\\$1')}"`;
    return script;
  };
  for (const n of [1, 2, 3, 4, 6, 9])
    assert.equal(denies(nest(n, 'npm publish')), true, `depth ${n}`);
  // Quotes that run together make one long script word, 300 levels deep.
  let flat = 'npm publish';
  for (let i = 0; i < 300; i++) flat = `ssh h '${flat}'`;
  assert.equal(denies(flat), true, 'flat 300');
  assert.equal(denies(`${flat}${pad}`), true, 'flat 300 padded');
  // A script-taking word alone does not trigger the cap.
  assert.equal(denies(`ssh host 'ls${pad}'`), false);
  assert.equal(denies(`ssh host 'echo ok' ${'a '.repeat(1100)}`), false);
});

test('round 6: pn, pnx and yarnpkg are runners', () => {
  for (const command of [
    'pn publish',
    'pn -r publish',
    'pn --filter x publish',
    'pnx lerna publish',
    'pnx -y changeset publish',
    'yarnpkg publish',
    'yarnpkg npm publish',
    'yarnpkg --cwd x publish',
    '/usr/bin/pn publish',
    'nohup pn publish',
    "sh -c 'yarnpkg publish'",
    "pn exec 'lerna publish'",
    'if true; then pnx lerna publish; fi',
  ])
    assert.equal(denies(command), true, command);
  for (const command of [
    'pn install',
    'pnx cowsay hi',
    'yarnpkg install',
    'ls pn',
    'git commit -m "pn"',
  ])
    assert.equal(denies(command), false, command);
});
