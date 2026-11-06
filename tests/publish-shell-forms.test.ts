import test from 'node:test';
import {expectAll} from './helpers/verdict.ts';

// EL-115 / PR 5, round 4. A publish stays a publish when the command carries
// an expansion, comes after a shell keyword, or is run by a wrapper.
// Commands are only parsed, never run.

test('round 4: a script with an expansion is still read', async () => {
  await expectAll(
    [
      'npx -c "lerna publish $FLAGS"',
      'npx -c "pnpm -r publish $FLAGS"',
      'npm exec --call="lerna publish $FLAGS"',
      'yarn exec "lerna publish $F"',
      'pnpm exec -c "lerna publish $F"',
      'npx -c "lerna publish ${FLAGS:-}"',
      'npx -c "lerna publish $(echo x)"',
      'npm -c "lerna publish $F" exec',
      'npx --call="npm pub $F"',
      "npm $'publish'",
      'npm "$X" publish',
    ],
    'DENY',
  );
});

test('round 4: shell keywords and grouping do not hide the command', async () => {
  await expectAll(
    [
      'if true; then npm --loglevel=x publish; fi',
      'if npm publish; then :; fi',
      'if true\nthen\nnpm publish\nfi',
      'for i in 1 2; do lerna publish; done',
      'while true; do npm publish; done',
      'until false; do pnpm -r publish; done',
      'while ! npm publish; do :; done',
      '! npm publish',
      'true && ! npm publish',
      'f() { npm publish; }',
      'function f { npm publish; }',
      '{ lerna publish; }',
      'then env FOO=1 npm publish',
      'if true; then time npm -w pkg publish; fi',
      'coproc npm publish',
    ],
    'DENY',
  );
});

test('round 4: wrappers that run a command do not hide it', async () => {
  await expectAll(
    [
      'exec -a x lerna publish',
      'exec -a x -c npm publish',
      'flock /tmp/lock npm publish',
      'flock -n /tmp/lock -c "npm publish"',
      'unshare -r npm publish',
      'taskset 1 npm publish',
      'taskset -c 0 pnpm -r publish',
      "script -c 'npm publish' /dev/null",
      'find . -exec npm publish \\;',
      'find . -name package.json -execdir yarn npm publish \\;',
      'chroot /x npm publish',
      'nsenter -t 1 npm publish',
      'runuser -u x npm publish',
      "su -c 'npm publish' x",
      "ssh host 'npm publish'",
    ],
    'DENY',
  );
});
