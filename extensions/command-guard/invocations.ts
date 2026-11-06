import {basename} from 'node:path';
import {ghArgs} from './gh.ts';
import {withoutGitGlobals} from './git.ts';
import {execPayloads} from './find-exec.ts';
import {isPrefix} from './prefixes.ts';
import {expandScripts} from './scripts.ts';
import type {Word} from './shell.ts';
import {
  MAX_DEPTH,
  MAX_TOOL_STARTS,
  Skipped,
  chargePayload,
  chargeStarts,
  tooLarge,
  type Reading,
  type Run,
} from './view-limits.ts';
import {commandOf} from './view-command.ts';
import {scriptsOf} from './view-scripts.ts';

// The invocation view: one line per simple command, as the program would be
// started. Shell keywords, assignments, `env` and `time` are removed, the
// program is named without its directory, and words are spelled without
// quoting. This is what `BashCmdRegex` rules are matched against, so a rule
// written `^pnpm -r publish` also covers `FOO=1 env /usr/bin/pnpm -r publish`
// and `if true; then pnpm -r publish; fi`.

const TOOLS = new Set(['git', 'gh', 'kubectl', 'helm']);
export function spell(word: Word): string {
  if (/^[A-Za-z0-9_@%+=:,./~^-]+$/u.test(word.text)) return word.text;
  return `'${word.text.replaceAll("'", "'\\''")}'`;
}

function nameOf(word: Word): string {
  return word.dynamic ? '' : basename(word.text);
}

function line(words: Word[]): string {
  const [program, ...args] = words;
  const name = program.dynamic ? spell(program) : basename(program.text);

  return [name, ...args.map(spell)].join(' ');
}

// What `find -exec` runs is a command too, and so is a literal `sh -c` script
// among it. Only the commands are read: a script that cannot be read is not
// followed, but then there is no view.
function collectPayload(payload: Word[], read: Reading, depth: number): void {
  chargePayload(payload, read);
  const {segments, decisions} = expandScripts([payload]);
  if (decisions.length > 0) throw new Skipped();
  for (const segment of segments) collect(segment, read, depth);

  // A payload that opens with an option is no command: it began at a word that
  // was only an operand, so an action may follow inside it.
  if (!payload[0]?.text.startsWith('-')) return;
  if (depth >= MAX_DEPTH) throw new Skipped();
  for (const inner of execPayloads(payload))
    collectPayload(inner, read, depth + 1);
}

function collect(words: Word[], read: Reading, depth: number): void {
  const start = commandOf(words);
  const {command, resolved} = start;
  if (command.length === 0) return;

  const open = !resolved || (isPrefix(command[0]) && command.length > 1);
  read.runs.push({command, open});
  if (open) chargeStarts(command, read);

  // A script the guard's own expansion did not reach.
  if (start.stripped || open) {
    if (depth >= MAX_DEPTH) throw new Skipped();
    for (const inner of scriptsOf(start, open, read))
      collect(inner, read, depth + 1);
  }

  // One scan from the first `find` reads every payload after it.
  const at = command.findIndex((word, i) => (open || i === 0) && isFind(word));
  if (at < 0) return;
  if (depth >= MAX_DEPTH) throw new Skipped();

  for (const payload of execPayloads(command.slice(at + 1)))
    collectPayload(payload, read, depth + 1);
}

function isFind(word: Word): boolean {
  return nameOf(word) === 'find';
}

// Undefined when there is no view: the command is large, or nests more than
// the view follows, or runs a script it cannot read.
function runsOf(segments: Word[][]): Run[] | undefined {
  if (tooLarge(segments)) return undefined;

  const read: Reading = {runs: [], words: 0, chars: 0};
  try {
    for (const segment of segments) collect(segment, read, 0);
  } catch (error) {
    if (error instanceof Skipped) return undefined;
    throw error;
  }
  return read.runs;
}

// Every start of an open command: `line(command.slice(i))` for each `i`, as
// the tail of one spelling of the whole command.
function startsOf(command: Word[]): string[] {
  const spelled = command.map(spell);
  const full = spelled.join(' ');
  let end = 0;

  return command.map((word, i) => {
    end += spelled[i].length + (i > 0 ? 1 : 0);
    const name = word.dynamic ? spelled[i] : basename(word.text);
    return name + full.slice(end);
  });
}

function runLines(runs: Run[]): string[] {
  const views = new Set<string>();

  for (const {command, open} of runs) {
    if (!open) views.add(line(command));
    else for (const view of startsOf(command)) views.add(view);
  }

  return [...views];
}

// The git, gh, kubectl or helm commands that run, as a rule names them:
// without Git or GitHub global options (`git -C repo push` is `git push`).
// A tool named only as an argument (`echo git status`) is not one, unless a
// prefix could be running it.
// Throws `Skipped` when a command names too many tools to read each start.
function toolLines(runs: Run[]): string[] {
  const views = new Set<string>();

  for (const {command, open} of runs) {
    const positions = open ? command.map((_, i) => i) : [0];
    const starts = positions.filter(i => TOOLS.has(nameOf(command[i])));
    if (starts.length > MAX_TOOL_STARTS) throw new Skipped();

    for (const i of starts) {
      const tool = nameOf(command[i]);

      let args = command.slice(i + 1);
      if (tool === 'git') args = withoutGitGlobals(args).rest;
      else if (tool === 'gh') args = ghArgs(args);
      views.add([tool, ...args.map(spell)].join(' '));
    }
  }

  return [...views];
}

// The line of each simple command, for tests; empty when there is no view.
export function invocations(segments: Word[][]): string[] {
  const runs = runsOf(segments);
  return runs ? runLines(runs) : [];
}

// How many times a view was built, so a test can see that a policy without a
// view rule builds none.
export const viewStats = {built: 0};

// Every view of the command, or undefined when there is none.
export function invocationViews(segments: Word[][]): string[] | undefined {
  viewStats.built++;
  const runs = runsOf(segments);
  if (!runs) return undefined;

  try {
    return [...new Set([...runLines(runs), ...toolLines(runs)])];
  } catch (error) {
    if (error instanceof Skipped) return undefined;
    throw error;
  }
}
