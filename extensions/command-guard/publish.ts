import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import {
  INFO_FLAGS,
  KEEPS_COMMAND,
  OPTIONED_WRAPPERS,
  VALUE_OPTIONS,
  type Tool,
} from './publish-options.ts';
import {
  firstWords,
  literal,
  npmCommand,
  programOf,
  startsWithPublish,
} from './publish-scan.ts';
import {expandScripts, unwrap} from './scripts.ts';
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
const MAX_DEPTH = 3;

const SCRIPT_RUNNERS = new Set(['run', 'run-script', 'rum', 'urn']);
const RECURSIVE = new Set(['recursive', 'multi', 'm']);
const FETCHERS = new Set(['exec', 'x', 'dlx']);
// Whether a shell script, such as the value of `npx -c`, runs a publish.
function scriptPublishes(script: string): boolean {
  return expandScripts(parseSegments(script)).segments.some(
    segment => classifyPublish(segment).length > 0,
  );
}

// The script of an option such as `-c script`, `-c=script` or `--call=script`.
function callScripts(args: Word[], end: number): string[] {
  const scripts: string[] = [];

  for (let i = 0; i < end; i++) {
    const {text} = args[i];
    const attached = /^(?:--call=|-c=?(?=.))/u.exec(text);

    if (attached && text !== '--call=')
      scripts.push(text.slice(attached[0].length));
    else if (['-c', '--call'].includes(text) && i + 1 < args.length)
      scripts.push(args[i + 1].text);
  }

  return scripts;
}

// A program fetched and run by `npx`, `npm exec`, `pnpm dlx` and the like.
// `-c script` of npx and npm exec is a shell script, not a program name; it
// is an option of the runner only up to the program, after which it belongs
// to the program (`npm exec -- tsc --call=x` runs no script).
function fetched(args: Word[], depth: number, npmStyle: boolean): boolean {
  const valued = npmStyle ? VALUE_OPTIONS.runner : VALUE_OPTIONS.dlx;
  const starts = firstWords(args, valued);
  const last = starts.length > 0 ? Math.max(...starts) : args.length;
  // A dynamic word before the program may be an option, so look at all.
  const end = args.slice(0, last + 1).some(word => word.dynamic)
    ? args.length
    : last;

  return (
    (npmStyle && callScripts(args, end).some(scriptPublishes)) ||
    starts.some(i =>
      publishes(programOf(args[i]), args.slice(i + 1), depth + 1),
    )
  );
}

// `pnpm exec` and `yarn exec` hand their arguments, joined, to a shell, and
// `pnpm dlx -c` does the same.
function execPublishes(args: Word[], depth: number): boolean {
  const joined = (from: number) =>
    scriptPublishes(
      args
        .slice(from)
        .map(word => word.text)
        .join(' '),
    );

  return (
    firstWords(args, VALUE_OPTIONS.dlx).some(joined) ||
    fetched(args, depth, false)
  );
}

function runsPublish(tool: Tool, args: Word[], depth: number): boolean {
  const valued = VALUE_OPTIONS[tool];
  const info = tool === 'npm' ? INFO_FLAGS : undefined;

  return firstWords(args, valued, info).some(i => {
    const name =
      tool === 'npm' ? npmCommand(literal(args[i])) : literal(args[i]);
    const rest = args.slice(i + 1);

    if (name === 'publish') return true;
    if (SCRIPT_RUNNERS.has(name)) return startsWithPublish(rest, valued);
    if (tool === 'lerna' && name === 'exec')
      return firstWords(rest, valued).some(j => nested(rest.slice(j), depth));
    if (TOOLS.has(name) && tool === 'yarn')
      return publishes(name, rest, depth + 1);
    if (FETCHERS.has(name) && tool === 'npm') return fetched(rest, depth, true);
    if (FETCHERS.has(name) && ['pnpm', 'yarn'].includes(tool))
      return execPublishes(rest, depth);
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
