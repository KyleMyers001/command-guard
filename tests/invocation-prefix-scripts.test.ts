import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeCommand} from '../extensions/command-guard/commands.ts';
import {decide} from './helpers/decide.ts';

// EL-115, PR 4, commit 5 (Codex 4458511496 and 4459102145): the view reads a
// literal `sh -c` or `eval` script run after a prefix (`command`, `sudo`,
// `nohup`, `timeout`, `xargs` ...), after `if ... then`, and in a `find -exec`
// payload. The guard's own verdicts do not change.

const cwd = process.cwd();
const views = (command: string) => analyzeCommand(command, cwd).invocations;
const PUBLISH = 'pnpm -r publish';
const RULE = `BashCmdRegex(^${PUBLISH})`;
const script = `'echo ok; ${PUBLISH}'`;

const hidden = {
  command: `command bash -c ${script}`,
  sudo: `sudo bash -c ${script}`,
  sudoUser: `sudo -u root -H bash -c ${script}`,
  sudoEnv: `sudo env FOO=1 bash -c ${script}`,
  envSudo: `env sudo -n bash -c ${script}`,
  doas: `doas sh -c ${script}`,
  nohup: `nohup bash -lc ${script}`,
  exec: `exec zsh -c ${script}`,
  timeout: `timeout 5 bash -c ${script}`,
  nice: `nice -n 5 dash -c ${script}`,
  ionice: `ionice -c3 bash -c ${script}`,
  setsid: `setsid -f bash -c ${script}`,
  stdbuf: `stdbuf -oL bash -c ${script}`,
  xargs: `echo x | xargs -I{} bash -c ${script}`,
  eval: `sudo eval ${script}`,
  twice: `sudo command bash -c ${script}`,
  inScript: `bash -c "sudo bash -c ${script}"`,
  afterKeyword: `if true; then sudo bash -c ${script}; fi`,
  afterTime: `time ! sudo bash -c ${script}`,
  inBrace: `{ command bash -c ${script}; }`,
  // The Codex cases of thread 4459102145.
  ifThen: `if true; then bash -c ${script}; fi`,
  findExec: `find . -exec bash -c ${script} \\;`,
  findPlus: `find . -exec bash -c ${script} +`,
  sudoFind: `sudo find . -exec bash -c ${script} \\;`,
};

test('a script run after a prefix or in a payload is read', async t => {
  for (const [name, command] of Object.entries(hidden)) {
    assert.ok(views(command)?.includes(PUBLISH), name);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'DENY', name);
    assert.equal(await decide(t, {ask: [RULE]}, command), 'ASK', name);
  }
});

test('a script that does not publish is not blocked', async t => {
  for (const command of [
    `command bash -c 'echo ${PUBLISH}'`,
    "sudo bash -c 'echo ok; pnpm -r build'",
    "xargs -I{} bash -c 'echo {}; ls'",
    'timeout 5 bash -c "echo ok"',
    'sudo apt install bash',
    'sudo ls eval',
  ]) {
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
  }
});

test('a prefixed script that cannot be read has no view and no new decision', async t => {
  for (const command of [
    'sudo bash -c "$X"',
    'command sh -c "echo $Y"',
    'timeout 5 bash -c "$(cat f)"',
    'nohup eval "$X"',
  ]) {
    assert.equal(views(command), undefined, command);
    assert.deepEqual(analyzeCommand(command, cwd).decisions, [], command);
    assert.equal(await decide(t, {deny: [RULE]}, command), 'ALLOW', command);
    assert.equal(
      await decide(t, {deny: [RULE]}, `${command}; ${PUBLISH}`),
      'DENY',
      command,
    );
  }
});

test('the guard decides as before on a prefixed script', () => {
  // Its own verdict on `sudo bash -c <script>` never read the script.
  for (const command of Object.values(hidden)) {
    const {decisions} = analyzeCommand(command, cwd);
    assert.deepEqual(
      decisions.map(decision => decision.verdict),
      [],
      command,
    );
  }
});

test('a prefix that runs a long list of shells stays within the work limit', () => {
  const started = performance.now();
  const command = `sudo ${'bash '.repeat(600)}-c ${script}`;
  const long = views(command);
  assert.ok(performance.now() - started < 400);
  assert.ok(long === undefined || long.includes(PUBLISH));
  // A command of that size is read, or not read at all; never partly.
  const found = views(`sudo ${'bash '.repeat(20)}-c ${script}`);
  assert.ok(found?.includes(PUBLISH));
});
