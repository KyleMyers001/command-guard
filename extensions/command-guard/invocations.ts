import {basename} from 'node:path';
import {ghArgs} from './gh.ts';
import {withoutGitGlobals} from './git.ts';
import {execPayloads} from './find-exec.ts';
import {isPrefix} from './prefixes.ts';
import {expandScripts, unwrap} from './scripts.ts';
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

// The view is built only for a command this size or smaller, and nested no
// deeper than this; past a limit there is no view (see `invocationViews`).
const MAX_WORDS = 1000;
const MAX_CHARS = 8192;
const MAX_DEPTH = 32;
// Tool names in one open command that are each read as a start of their own.
const MAX_TOOL_STARTS = 32;

class Skipped extends Error {}

// What `find -exec` runs is a command too, and so is a literal `sh -c` script
// among it. Only the commands are read: a script that cannot be read is not
// followed, but then there is no view.
function collectPayload(payload: Word[], runs: Run[], depth: number): void {
  const {segments, decisions} = expandScripts([payload]);
  if (decisions.length > 0) throw new Skipped();
  for (const segment of segments) collect(segment, runs, depth);

  // A payload that opens with an option is no command: it began at a word that
  // was only an operand, so an action may follow inside it.
  if (!payload[0]?.text.startsWith('-')) return;
  if (depth >= MAX_DEPTH) throw new Skipped();
  for (const inner of execPayloads(payload))
    collectPayload(inner, runs, depth + 1);
}

function collect(words: Word[], runs: Run[], depth: number): void {
  const {command, resolved} = unwrap(withoutKeywords(words));
  if (command.length === 0) return;

  const open = !resolved || (isPrefix(command[0]) && command.length > 1);
  runs.push({command, open});

  // One scan from the first `find` reads every payload after it.
  const at = command.findIndex((word, i) => (open || i === 0) && isFind(word));
  if (at < 0) return;
  if (depth >= MAX_DEPTH) throw new Skipped();

  for (const payload of execPayloads(command.slice(at + 1)))
    collectPayload(payload, runs, depth + 1);
}

function isFind(word: Word): boolean {
  return nameOf(word) === 'find';
}

function tooLarge(segments: Word[][]): boolean {
  let words = 0;
  let chars = 0;
  for (const segment of segments) {
    words += segment.length;
    for (const word of segment) chars += word.text.length;
    if (words > MAX_WORDS || chars > MAX_CHARS) return true;
  }
  return false;
}

// Undefined when there is no view: the command is large, or nests more than
// the view follows, or runs a script it cannot read.
function runsOf(segments: Word[][]): Run[] | undefined {
  if (tooLarge(segments)) return undefined;

  const runs: Run[] = [];
  try {
    for (const segment of segments) collect(segment, runs, 0);
  } catch (error) {
    if (error instanceof Skipped) return undefined;
    throw error;
  }
  return runs;
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

// Every view of the command, or undefined when there is none.
export function invocationViews(segments: Word[][]): string[] | undefined {
  const runs = runsOf(segments);
  if (!runs) return undefined;

  try {
    return [...new Set([...runLines(runs), ...toolLines(runs)])];
  } catch (error) {
    if (error instanceof Skipped) return undefined;
    throw error;
  }
}
