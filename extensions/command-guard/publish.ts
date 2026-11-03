import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import {
  INFO_FLAGS,
  KEEPS_COMMAND,
  OPTIONED_WRAPPERS,
  SHELL_KEYWORDS,
} from './publish-options.ts';
import {
  isNpmPublish,
  isScript,
  literal,
  programOf,
  tokens,
} from './publish-scan.ts';
import {expandScripts, unwrap} from './scripts.ts';
import {parseSegments, type Word} from './shell.ts';

// Package publishing is hard to undo, so it is always denied. The rule is
// deliberately blunt and does not read option grammar: when a command runs
// npm, pnpm, yarn, npx, lerna or changesets, any word of it that is `publish`,
// or any word inside a script string it carries (`npx -c`, `yarn exec`), is
// a publish, whatever the options. That denies a few commands that only
// mention publish (`npm install publish`); publishing is rare. Only help
// and version output is left alone (`npm help publish`, `npm -h publish`).
// A command that merely has these words in another tool's arguments
// (`rg 'npm publish'`) is not an invocation of these tools.

const PUBLISHES: Decision = {
  verdict: 'deny',
  reason:
    'package publish (npm, pnpm, yarn, lerna or changesets, including workspace and script forms) cannot be undone',
  advice:
    'Inspect the package with `npm pack --dry-run`, and publish from CI or a terminal outside Pi.',
};

const TOOLS = new Set(['npm', 'pnpm', 'yarn', 'lerna', 'changeset']);
const RUNNERS = new Set(['npx', 'pnpx']);
const MAX_DEPTH = 3;

// Whether a shell script, such as the value of `npx -c`, runs a publish.
function scriptPublishes(script: string, depth: number): boolean {
  return (
    depth > MAX_DEPTH ||
    expandScripts(parseSegments(script)).segments.some(
      segment => classify(segment, depth + 1).length > 0,
    )
  );
}

// Whether the program `name` run with these arguments publishes.
function publishes(name: string, args: Word[], depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (!TOOLS.has(name) && !RUNNERS.has(name)) return false;
  // npm stops at help and version flags when they come first.
  if (
    name === 'npm' &&
    args[0] &&
    !args[0].dynamic &&
    (args[0].text === 'help' || INFO_FLAGS.has(args[0].text))
  )
    return false;

  return args.some((word, i) => {
    // A dynamic word keeps its literal text, so `"lerna publish $F"` is read.
    if (tokens(word.text).includes('publish')) return true;
    // `--call=script` and `-cscript` carry the script after the option.
    if (isScript(word))
      return [word.text, word.text.replace(/^(?:--call=|-c=?)/u, '')].some(
        text => scriptPublishes(text, depth),
      );
    if (name === 'npm' && isNpmPublish(word.text)) return true;
    // A tool started by this one: `npx lerna`, `yarn npm pub`, `pnpm exec`.
    return publishes(programOf(word), args.slice(i + 1), depth + 1);
  });
}

// Words that may start a command, after wrappers that leave it in place.
// `wrapped` is set when the command is a wrapper's argument, where a word may
// also be a whole script (`script -c 'npm publish'`).
function commandStarts(words: Word[]): {starts: number[]; wrapped: boolean} {
  const starts: number[] = [];
  let wrapped = false;

  for (let i = 0; i < words.length;) {
    const name = basename(literal(words[i]));
    if (SHELL_KEYWORDS.has(words[i].text)) i++;
    else if (KEEPS_COMMAND.has(name) || name === 'corepack') {
      i++;
      while (words[i]?.text.startsWith('-')) i++;
    } else if (OPTIONED_WRAPPERS.has(name)) {
      for (let j = i + 1; j < words.length; j++) starts.push(j);
      wrapped = true;
      break;
    } else {
      starts.push(i);
      break;
    }
  }

  return {starts, wrapped};
}

function nested(words: Word[], depth: number): boolean {
  const {starts, wrapped} = commandStarts(words);
  return starts.some(
    i =>
      publishes(basename(literal(words[i])), words.slice(i + 1), depth) ||
      (wrapped && isScript(words[i]) && scriptPublishes(words[i].text, depth)),
  );
}

function classify(segment: Word[], depth: number): Decision[] {
  const first = segment.findIndex(word => !SHELL_KEYWORDS.has(word.text));
  const {command, resolved} = unwrap(first < 0 ? [] : segment.slice(first));
  const found = resolved
    ? nested(command, depth)
    : command.some((_, i) => nested(command.slice(i), depth));

  return found ? [PUBLISHES] : [];
}

// `segment` is one simple command. When an option of `env` or `time` is
// unknown, any later word may start the command.
export function classifyPublish(segment: Word[]): Decision[] {
  return classify(segment, 0);
}
