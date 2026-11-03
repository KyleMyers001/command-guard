import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import type {Tool} from './publish-options.ts';
import {VALUE_OPTIONS} from './publish-options.ts';
import {unwrap} from './scripts.ts';
import {parseSegments, type Word} from './shell.ts';

// Package publishing is hard to undo, so it is always denied. This reads a
// command's decoded arguments instead of its text, so the options npm, pnpm,
// yarn, lerna and changesets accept before the subcommand cannot hide it:
// `pnpm -r publish`, `npm -w pkg publish`, `yarn workspaces foreach npm publish`.
// Where it cannot tell an option's value from the subcommand it assumes the
// word is the subcommand, which can only deny more.

const PUBLISHES: Decision = {
  verdict: 'deny',
  reason:
    'package publish (npm, pnpm, yarn, lerna or changesets, including workspace and script forms) cannot be undone',
  advice:
    'Inspect the package with `npm pack --dry-run`, and publish from CI or a terminal outside Pi.',
};

const TOOLS = new Set<string>(['npm', 'pnpm', 'yarn', 'lerna', 'changeset']);
const RUNNERS = new Set(['npx', 'pnpx']);
// The first wrapper word is the command; the rest cannot be told apart from
// its own options, so any later word may be the command.
const KEEPS_COMMAND = new Set([
  'command',
  'exec',
  'builtin',
  'nohup',
  'setsid',
]);
const OPTIONED_WRAPPERS = new Set([
  'sudo',
  'doas',
  'nice',
  'ionice',
  'xargs',
  'timeout',
  'stdbuf',
  'caffeinate',
]);
const MAX_DEPTH = 3;

const SCRIPT_RUNNERS = new Set(['run', 'run-script', 'rum', 'urn']);
// npm prints help or the version and stops at these, whatever follows.
const INFO_FLAGS = new Set(['-h', '-?', '--help', '--version', '-v']);
const RECURSIVE = new Set(['recursive', 'multi', 'm']);
const FETCHERS = new Set(['exec', 'x', 'dlx']);
function literal(word: Word | undefined): string {
  return !word || word.dynamic ? '' : word.text;
}

// Indexes where the first non-option word may be. A dynamic word, or an option
// whose value is unknown, is counted both ways.
function firstWords(args: Word[], valued: Set<string>): number[] {
  const found = new Set<number>();
  const seen = new Set<number>();
  const todo = [0];

  for (let i = todo.pop(); i !== undefined; i = todo.pop()) {
    if (i >= args.length || seen.has(i)) continue;
    seen.add(i);
    const {text, dynamic} = args[i];

    if (text === '--') found.add(i + 1);
    else if (dynamic) {
      found.add(i);
      todo.push(i + 1);
    } else if (!text.startsWith('-') || text === '-') found.add(i);
    else if (text.includes('=')) todo.push(i + 1);
    else if (valued.has(text)) todo.push(i + 2);
    else todo.push(i + 1, i + 2);
  }

  return [...found].filter(i => i < args.length);
}

// Whether `publish` can be the script name or subcommand at the start of args.
function startsWithPublish(args: Word[], valued: Set<string>): boolean {
  return firstWords(args, valued).some(i => literal(args[i]) === 'publish');
}

// `lerna@7` and `@changesets/cli@2` name the program `lerna` and the changesets CLI.
function programOf(word: Word): string {
  const name = literal(word).replace(/(?<=.)@[^/@]*$/u, '');
  return name === '@changesets/cli' ? 'changeset' : basename(name);
}

function npmCommand(name: string): string {
  // npm accepts any unambiguous prefix of a command name: `npm pu` publishes.
  if (name.length >= 2 && 'publish'.startsWith(name)) return 'publish';
  return name.length >= 5 && name.startsWith('run-') ? 'run-script' : name;
}

// Whether a shell script, such as the value of `npx -c`, runs a publish.
function scriptPublishes(script: string): boolean {
  return parseSegments(script).some(
    segment => classifyPublish(segment).length > 0,
  );
}

// A program fetched and run by `npx`, `npm exec`, `pnpm dlx` and the like.
// `-c script` of npx and npm exec is a shell script, not a program name.
function fetched(args: Word[], depth: number, npmStyle: boolean): boolean {
  const calls = args.some(
    (word, i) =>
      npmStyle &&
      ['-c', '--call'].includes(word.text) &&
      i + 1 < args.length &&
      scriptPublishes(args[i + 1].text),
  );
  const valued = npmStyle ? VALUE_OPTIONS.runner : VALUE_OPTIONS.dlx;

  return (
    calls ||
    firstWords(args, valued).some(i =>
      publishes(programOf(args[i]), args.slice(i + 1), depth + 1),
    )
  );
}

function runsPublish(tool: Tool, args: Word[], depth: number): boolean {
  const valued = VALUE_OPTIONS[tool];

  return firstWords(args, valued).some(i => {
    if (tool === 'npm' && args.slice(0, i).some(w => INFO_FLAGS.has(w.text)))
      return false;
    const name =
      tool === 'npm' ? npmCommand(literal(args[i])) : literal(args[i]);
    const rest = args.slice(i + 1);

    if (name === 'publish') return true;
    if (SCRIPT_RUNNERS.has(name)) return startsWithPublish(rest, valued);
    if (tool === 'lerna' && name === 'exec')
      return firstWords(rest, valued).some(j => nested(rest.slice(j), depth));
    if (TOOLS.has(name) && tool === 'yarn')
      return publishes(name, rest, depth + 1);
    // `yarn exec` runs its arguments, joined, as a shell script.
    if (tool === 'yarn' && name === 'exec')
      return scriptPublishes(rest.map(word => word.text).join(' '));
    if (FETCHERS.has(name) && ['npm', 'pnpm', 'yarn'].includes(tool))
      return fetched(rest, depth, tool === 'npm');
    // pnpm runs a dependency's program by name: `pnpm changeset publish`.
    if (tool === 'pnpm' && TOOLS.has(name))
      return publishes(name, rest, depth + 1);
    // `pnpm recursive run publish`, `pnpm recursive exec lerna publish`.
    if (tool === 'pnpm' && RECURSIVE.has(name))
      return runsPublish(tool, rest, depth);
    if (tool !== 'yarn') return false;

    // Yarn: `yarn npm publish`, `yarn workspace <name> <cmd>`,
    // `yarn workspaces foreach|run <cmd>`.
    if (name === 'workspace')
      return firstWords(rest, valued).some(j =>
        runsPublish(tool, rest.slice(j + 1), depth),
      );
    if (name === 'workspaces')
      return firstWords(rest, valued).some(
        j =>
          ['foreach', 'run'].includes(literal(rest[j])) &&
          runsPublish(tool, rest.slice(j + 1), depth),
      );
    return false;
  });
}

// Whether the program `name` with these arguments publishes.
function publishes(name: string, args: Word[], depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (RUNNERS.has(name)) return fetched(args, depth, true);
  return TOOLS.has(name) && runsPublish(name as Tool, args, depth);
}

// Words that may start a command, after wrappers that leave it in place.
function commandStarts(words: Word[]): number[] {
  const starts: number[] = [];

  for (let i = 0; i < words.length;) {
    const name = basename(literal(words[i]));
    if (KEEPS_COMMAND.has(name) || name === 'corepack') {
      i++;
      while (words[i]?.text.startsWith('-')) i++;
    } else if (OPTIONED_WRAPPERS.has(name)) {
      for (let j = i + 1; j < words.length; j++) starts.push(j);
      break;
    } else {
      starts.push(i);
      break;
    }
  }

  return starts;
}

function nested(words: Word[], depth: number): boolean {
  return commandStarts(words).some(i =>
    publishes(basename(literal(words[i])), words.slice(i + 1), depth),
  );
}

// `segment` is one simple command. When an option of `env` or `time` is
// unknown, any later word may start the command.
export function classifyPublish(segment: Word[]): Decision[] {
  const {command, resolved} = unwrap(segment);
  const found = resolved
    ? nested(command, 0)
    : command.some((_, i) => nested(command.slice(i), 0));

  return found ? [PUBLISHES] : [];
}
