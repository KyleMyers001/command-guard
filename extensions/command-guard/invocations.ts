import {basename} from 'node:path';
import {unwrap} from './scripts.ts';
import type {Word} from './shell.ts';

// The invocation view: one line per simple command, as the program would be
// started. Assignments, `env` and `time` are removed, the program is named
// without its directory, and words are spelled without quoting. This is what
// `BashCmdRegex` rules are matched against, so a rule written `^pnpm -r publish`
// also covers `FOO=1 env /usr/bin/pnpm -r publish`.

// Programs that run the rest of their arguments as a command.
const PREFIXES = new Set([
  'sudo',
  'doas',
  'nohup',
  'command',
  'exec',
  'nice',
  'ionice',
  'timeout',
  'xargs',
  'stdbuf',
  'setsid',
]);
// Start positions tried after a prefix or an unknown wrapper option. Bounds
// the work for a very long command; the whole-command view is always kept.
const MAX_STARTS = 32;

export function spell(word: Word): string {
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/u.test(word.text)) return word.text;
  return `'${word.text.replaceAll("'", "'\\''")}'`;
}

function line(words: Word[]): string {
  const [program, ...args] = words;
  const name = program.dynamic ? spell(program) : basename(program.text);

  return [name, ...args.map(spell)].join(' ');
}

// Every place the real command may start: the front when the wrappers are
// known, every later word when `env` or `time` has an option that is not
// understood, and every word after a prefix such as `sudo` or `timeout`.
function starts(command: Word[], resolved: boolean): number[] {
  const first = command[0];
  const prefixed =
    !first.dynamic && PREFIXES.has(basename(first.text)) && command.length > 1;
  if (!resolved) return command.map((_, i) => i);

  return prefixed ? command.map((_, i) => i) : [0];
}

export function invocations(segments: Word[][]): string[] {
  const views = new Set<string>();

  for (const segment of segments) {
    const {command, resolved} = unwrap(segment);
    if (command.length === 0) continue;

    for (const start of starts(command, resolved).slice(0, MAX_STARTS)) {
      views.add(line(command.slice(start)));
    }
  }

  return [...views];
}
