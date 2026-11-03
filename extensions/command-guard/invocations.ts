import {basename} from 'node:path';
import {ghArgs} from './gh.ts';
import {withoutGitGlobals} from './git.ts';
import {execPayloads} from './find-exec.ts';
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

// Nested or repeated `-exec` is bounded: past these limits the view is not
// built at all, and the rules match the command's spelling as they did before
// the view existed.
const MAX_FIND_DEPTH = 8;
const MAX_PAYLOADS = 256;

class TooMuch extends Error {}

function collect(
  words: Word[],
  runs: Run[],
  budget: {payloads: number},
  depth: number,
): void {
  const {command, resolved} = unwrap(withoutKeywords(words));
  if (command.length === 0) return;

  const open = !resolved || (isPrefix(command[0]) && command.length > 1);
  runs.push({command, open});

  const positions = open ? command.map((_, i) => i) : [0];
  let covered = 0;
  for (const i of positions) {
    if (i < covered || nameOf(command[i]) !== 'find') continue;

    const {payloads, end} = execPayloads(command.slice(i + 1));
    covered = i + 1 + end;
    if (payloads.length === 0) continue;

    budget.payloads += payloads.length;
    if (depth >= MAX_FIND_DEPTH || budget.payloads > MAX_PAYLOADS)
      throw new TooMuch();
    for (const payload of payloads) collect(payload, runs, budget, depth + 1);
  }
}

// Undefined when the command has more `find -exec` than the view follows.
function runsOf(segments: Word[][]): Run[] | undefined {
  const runs: Run[] = [];
  const budget = {payloads: 0};
  try {
    for (const segment of segments) collect(segment, runs, budget, 0);
  } catch (error) {
    if (error instanceof TooMuch) return undefined;
    throw error;
  }
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

function runLines(runs: Run[]): string[] {
  const views = new Set<string>();
  const slices: string[] = [];

  for (const {command, open} of runs) {
    if (!open) {
      views.add(line(command));
      continue;
    }
    const {lines: starts, rest} = startsOf(command);
    for (const view of starts) views.add(view);
    slices.push(...rest);
  }

  return [...views, ...slices];
}

// The git, gh, kubectl or helm commands that run, as a rule names them:
// without Git or GitHub global options (`git -C repo push` is `git push`).
// A tool named only as an argument (`echo git status`) is not one, unless a
// prefix could be running it.
function toolLines(runs: Run[]): string[] {
  const views = new Set<string>();

  for (const {command, open} of runs) {
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

// The line of each simple command, for tests; empty past the limits.
export function invocations(segments: Word[][]): string[] {
  const runs = runsOf(segments);
  return runs ? runLines(runs) : [];
}

// Every view of the command, or undefined when it could not be built.
export function invocationViews(segments: Word[][]): string[] | undefined {
  const runs = runsOf(segments);
  return runs && [...new Set([...runLines(runs), ...toolLines(runs)])];
}
