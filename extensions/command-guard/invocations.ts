import {basename} from 'node:path';
import {ghArgs} from './gh.ts';
import {withoutGitGlobals} from './git.ts';
import {isPrefix} from './prefixes.ts';
import {unwrap} from './scripts.ts';
import type {Word} from './shell.ts';

// The invocation view: one line per simple command, as the program would be
// started. Shell keywords, assignments, `env` and `time` are removed, the
// program is named without its directory, and words are spelled without
// quoting. This is what `BashCmdRegex` rules are matched against, so a rule
// written `^pnpm -r publish` also covers `FOO=1 env /usr/bin/pnpm -r publish`
// and `if true; then pnpm -r publish; fi`.

// Words that stand where a command may start but are not part of it.
const KEYWORDS = new Set([
  '!',
  '{',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
]);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const TOOLS = new Set(['git', 'gh', 'kubectl', 'helm']);
// Starts written out line by line. A command with more words after a prefix
// has every later start too, as slices of one spelling.
const MAX_LINES = 32;

export function spell(word: Word): string {
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/u.test(word.text)) return word.text;
  return `'${word.text.replaceAll("'", "'\\''")}'`;
}

function nameOf(word: Word): string {
  return word.dynamic ? '' : basename(word.text);
}

// `segment` without the shell keywords that introduce its command.
export function withoutKeywords(segment: Word[]): Word[] {
  // A lone `{` is flagged dynamic (brace expansion) but is only the keyword.
  const keyword = ({text, dynamic}: Word) =>
    KEYWORDS.has(text) && (!dynamic || text === '{');

  let i = 0;
  while (i < segment.length && keyword(segment[i])) i++;
  return segment.slice(i);
}

function line(words: Word[]): string {
  const [program, ...args] = words;
  const name = program.dynamic ? spell(program) : basename(program.text);

  return [name, ...args.map(spell)].join(' ');
}

// A command that may run: `open` when any later word could be where the real
// command starts (after `sudo`, or an `env` option that is not understood).
interface Run {
  command: Word[];
  open: boolean;
}

// The commands `find` runs for -exec and its relatives.
function* execPayloads(args: Word[]): Generator<Word[]> {
  for (let i = 0; i < args.length; i++) {
    if (args[i].dynamic || !FIND_EXEC.has(args[i].text)) continue;

    const end = args.findIndex(
      (word, j) => j > i && !word.dynamic && /^[;+]$/u.test(word.text),
    );
    yield args.slice(i + 1, end < 0 ? args.length : end);
  }
}

function collect(words: Word[], runs: Run[]): void {
  const {command, resolved} = unwrap(withoutKeywords(words));
  if (command.length === 0) return;

  const open = !resolved || (isPrefix(command[0]) && command.length > 1);
  runs.push({command, open});

  const positions = open ? command.map((_, i) => i) : [0];
  for (const i of positions) {
    if (nameOf(command[i]) !== 'find') continue;
    for (const payload of execPayloads(command.slice(i + 1)))
      collect(payload, runs);
  }
}

function runsOf(segments: Word[][]): Run[] {
  const runs: Run[] = [];
  for (const segment of segments) collect(segment, runs);
  return runs;
}

// Every start of an open command: `line(command.slice(i))` for each `i`. Past
// MAX_LINES they are slices of one spelling, not new strings, so a command of
// thousands of words costs little to hold.
function startsOf(command: Word[]): {lines: string[]; rest: string[]} {
  const lines = command
    .slice(0, MAX_LINES)
    .map((_, i) => line(command.slice(i)));
  const rest: string[] = [];
  if (command.length <= MAX_LINES) return {lines, rest};

  const spelled = command.map(spell);
  const full = spelled.join(' ');
  let offset = 0;

  for (const [i, word] of command.entries()) {
    if (i >= MAX_LINES) {
      // The program loses its directory; when what is left is the tail of its
      // spelling, the rest of the line is already in `full`.
      const name = basename(word.text);
      const unchanged = spelled[i] === word.text && word.text.endsWith(name);
      if (word.dynamic) rest.push(full.slice(offset));
      else if (unchanged)
        rest.push(full.slice(offset + word.text.length - name.length));
      else rest.push(line(command.slice(i)));
    }
    offset += spelled[i].length + 1;
  }
  return {lines, rest};
}

export function invocations(segments: Word[][]): string[] {
  const views = new Set<string>();
  const slices: string[] = [];

  for (const {command, open} of runsOf(segments)) {
    if (!open) {
      views.add(line(command));
      continue;
    }
    const {lines, rest} = startsOf(command);
    for (const view of lines) views.add(view);
    slices.push(...rest);
  }

  return [...views, ...slices];
}

// The git, gh, kubectl or helm commands that run, as a rule names them:
// without Git or GitHub global options (`git -C repo push` is `git push`).
// A tool named only as an argument (`echo git status`) is not one, unless a
// prefix could be running it.
export function toolInvocations(segments: Word[][]): string[] {
  const views = new Set<string>();

  for (const {command, open} of runsOf(segments)) {
    const positions = open ? command.map((_, i) => i) : [0];

    for (const i of positions) {
      const tool = nameOf(command[i]);
      if (!TOOLS.has(tool)) continue;

      let args = command.slice(i + 1);
      if (tool === 'git') args = withoutGitGlobals(args).rest;
      else if (tool === 'gh') args = ghArgs(args);
      views.add([tool, ...args.map(spell)].join(' '));
    }
  }

  return [...views];
}
