import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import {INFO_FLAGS, SCRIPT_TAKERS, SHELL_KEYWORDS} from './publish-options.ts';
import {
  isNpmPublish,
  isScript,
  literal,
  nameOf,
  programOf,
  tokens,
} from './publish-scan.ts';
import {unwrap} from './scripts.ts';
import {parseSegments, type Word} from './shell.ts';

// Package publishing is hard to undo, so it is always denied. Any npm, pnpm,
// yarn, npx, lerna, changesets, vsce, ovsx or jsr word in a segment (also
// `name@version` or a path) starts a runner, so no wrapper needs listing.
// `publish` counts only where that runner reads it as what to do:
//
// - its subcommand: `npm publish`, `pnpm -r publish`, `npm pu`;
// - the script of `run`: `npm run publish`, `lerna run publish`;
// - after pnpm `recursive`, yarn `npm`, `workspace <name>` and
//   `workspaces [foreach ...]`;
// - inside a script given to `sh -c`, `eval`, `npx -c` and the like, or
//   quoted after a runner: `npx concurrently 'npm publish'`.
//
// A test filter, package name, option value or anything after `--` is not
// a publish, nor is a `test:`, `lint:` or `check:` script. Where the position
// cannot be read (an expansion or a long run of options before it) any later
// `publish` counts, and so does any `publish` text in a command too large to
// read. Help and version output is left alone where npm is the command:
// `npm help publish`, `npm -h publish`.
//
// Some words are data, not commands, so no runner starts there:
//
// - every argument of a search or print command (`rg`, `grep`, `git grep`,
//   `echo`, `printf`), unless the command line may run what it prints;
// - in a test run (`npm test`, `npm run test:unit`, `npx vitest`, ...), the
//   words after `--` and the value of `-t` or `--test-name-pattern`.

const PUBLISHES: Decision = {
  verdict: 'deny',
  reason:
    'package publish (npm, pnpm, yarn, lerna, changesets, vsce, ovsx or jsr, including workspace and script forms) cannot be undone',
  advice:
    'Inspect the package with `npm pack --dry-run`, and publish from CI or a terminal outside Pi.',
};

// `tool` is a CLI whose `publish` subcommand publishes to a registry of its
// own: VS Code extensions (vsce, ovsx) and JSR packages.
type Runner = 'npm' | 'pnpm' | 'yarn' | 'lerna' | 'changeset' | 'npx' | 'tool';

const RUNNERS = new Map<string, Runner>([
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['pn', 'pnpm'],
  ['yarn', 'yarn'],
  ['yarnpkg', 'yarn'],
  ['lerna', 'lerna'],
  ['changeset', 'changeset'],
  ['npx', 'npx'],
  ['pnpx', 'npx'],
  ['pnx', 'npx'],
  ['vsce', 'tool'],
  ['ovsx', 'tool'],
  ['jsr', 'tool'],
]);

// Options that always take the next word as their value. Any other option
// written without `=` may take the next word too, so both readings count.
const VALUE_OPTIONS: Record<Runner, ReadonlySet<string>> = {
  npm: new Set(['-w', '--workspace', '--prefix', '-C']),
  pnpm: new Set(['--filter', '-F', '--dir', '-C']),
  yarn: new Set(['--cwd']),
  lerna: new Set(),
  changeset: new Set(),
  npx: new Set(['-p', '--package']),
  tool: new Set(),
};

// Levels of script in a script. Past this the command is denied, as it is
// when it is too large to read and has a runner word and `publish` text.
const MAX_DEPTH = 3;
const MAX_WORDS = 1000;
const MAX_CHARS = 8192;
// Options read before a position. Past this the position is unknown.
const MAX_OPTIONS = 64;

function runnerOf(word: Word): Runner | undefined {
  if (word.dynamic || isScript(word)) return undefined;
  return RUNNERS.get(programOf(word));
}

// Whether `npm` is the command and stops at an info flag or `help`.
function isInfoForm(words: Word[]): boolean {
  const first = words.findIndex(word => !SHELL_KEYWORDS.has(word.text));
  const {command, resolved} = unwrap(first < 0 ? [] : words.slice(first));
  const [program, arg] = command;

  return (
    resolved &&
    program !== undefined &&
    runnerOf(program) === 'npm' &&
    arg !== undefined &&
    !arg.dynamic &&
    (arg.text === 'help' || INFO_FLAGS.has(arg.text))
  );
}

// A command too large to read in the time allowed. It is denied when its raw
// text, quoted scripts included, has a runner name and `publish` (or, with
// npm, a prefix of it such as `pub`) anywhere. One pass over the text, so it
// stays linear. A script-taking word alone does not count.
function tooLarge(words: Word[]): boolean {
  let chars = 0;
  for (const word of words) chars += word.text.length;
  return words.length > MAX_WORDS || chars > MAX_CHARS;
}

function largePublishes(words: Word[]): boolean {
  let runner = false;
  let npm = false;
  let publish = false;
  let prefix = false;

  for (const word of words) {
    for (const token of tokens(word.text)) {
      const name = nameOf(token);
      if (RUNNERS.has(name)) runner = true;
      if (name === 'npm') npm = true;
      if (token === 'publish') publish = true;
      else if (isNpmPublish(token)) prefix = true;
    }
  }

  return runner && (publish || (npm && prefix));
}

// The indexes that may hold the next positional word from `from`: the first
// word that is not an option, and the one after it while an option written
// without `=` may have taken it as a value. A word after `--` is positional.
// When options take every word (`pnpm --dir publish`), their values count.
// Undefined when an expansion or too many options hide the position.
function positions(
  words: Word[],
  from: number,
  values: ReadonlySet<string>,
): number[] | undefined {
  const found: number[] = [];
  const taken: number[] = [];
  let value = false;
  let mayBeValue = false;
  let options = 0;

  for (let i = from; i < words.length; i++) {
    const word = words[i];
    if (word.dynamic) return undefined;
    if (value) {
      value = false;
      taken.push(i);
    } else if (word.text === '--') {
      if (i + 1 < words.length) found.push(i + 1);
      return found;
    } else if (word.text.length > 1 && word.text.startsWith('-')) {
      if (++options > MAX_OPTIONS) return undefined;
      value = values.has(word.text);
      mayBeValue = !value && !word.text.includes('=');
    } else {
      found.push(i);
      if (!mayBeValue) return found;
      mayBeValue = false;
    }
  }
  return found.length > 0 ? found : taken;
}

// npm accepts an unambiguous prefix of a command: `npm run-s` is run-script.
const isNpmRun = (name: string): boolean =>
  name === 'rum' ||
  name === 'urn' ||
  (name.length >= 3 && 'run-script'.startsWith(name));

const isRun = (runner: Runner, name: string): boolean =>
  name === 'run' ||
  name === 'run-script' ||
  (runner === 'npm' && isNpmRun(name));

// A script that only tests or checks, the prefix grammar of the migration
// exemption: `test`, `test:unit`, `lint-publish`, `check:publish`.
const CHECK_SCRIPT = /^(?:test|lint|check)(?:[:-]|$)/u;
const TEST_SUBCOMMANDS = new Set(['test', 't', 'tst']);
const TEST_TOOLS = new Set([
  'vitest',
  'jest',
  'mocha',
  'ava',
  'playwright',
  'tap',
  'uvu',
]);
const TEST_NAME = /^(?:-t|--test-name-pattern)$/u;

// Commands whose arguments are data: what they search for or print.
const PRINTERS = new Set(['echo', 'printf']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg']);

// Returns a reader of a runner's words, from the word after its name, for a
// publish. `publishFrom` answers for a position that cannot be read. Each
// (runner, index) is read once, so the cost stays linear however the
// positions branch.
function reader(
  words: Word[],
  publishFrom: (from: number, npm: boolean) => boolean,
): (runner: Runner, from: number) => boolean {
  const seen = new Set<string>();

  // Whether the positional word after `from` passes `test`.
  const any = (
    runner: Runner,
    from: number,
    test: (index: number) => boolean,
  ): boolean => {
    const found = positions(words, from, VALUE_OPTIONS[runner]);
    return found === undefined
      ? publishFrom(from, runner === 'npm')
      : found.some(test);
  };

  // Whether the subcommand that starts at `from` publishes.
  const publishes = (runner: Runner, from: number): boolean => {
    const key = `${runner}:${from}`;
    if (runner === 'npx' || seen.has(key)) return false;
    seen.add(key);
    return any(runner, from, index => subcommand(runner, index));
  };

  const subcommand = (runner: Runner, index: number): boolean => {
    const name = words[index].text;
    const next = index + 1;
    if (name === 'publish' || (runner === 'npm' && isNpmPublish(name)))
      return true;
    if (runner === 'tool') return false;
    // The script of `run`: `npm run publish`, `yarn run publish:npm`.
    if (isRun(runner, name))
      return any(
        runner,
        next,
        at =>
          tokens(words[at].text).includes('publish') &&
          !CHECK_SCRIPT.test(words[at].text),
      );
    if (runner === 'pnpm' && /^(?:recursive|multi|m)$/u.test(name))
      return publishes(runner, next);
    if (runner !== 'yarn') return false;
    if (name === 'npm') return publishes(runner, next);
    // `yarn workspace <name> <command>`.
    if (name === 'workspace')
      return any(runner, next, at => publishes(runner, at + 1));
    // `yarn workspaces foreach [options] <command>`, `yarn workspaces run`.
    if (name === 'workspaces')
      return any(runner, next, at =>
        words[at].text === 'foreach'
          ? publishes(runner, at + 1)
          : subcommand(runner, at),
      );
    return false;
  };

  return publishes;
}

// Whether the text of a script, such as the value of `sh -c`, publishes.
function scriptPublishes(
  script: string,
  depth: number,
  runsOutput: () => boolean,
): boolean {
  return parseSegments(script).some(segment =>
    publishes(segment, depth + 1, runsOutput),
  );
}

// The words a script-taker joins after a script that ends in a runner:
// `ssh h 'a npm' publish` runs `npm publish`. The runner and the words of the
// script after it come first.
function carried(
  script: string,
  rest: Word[],
): {runner: Runner; words: Word[]} | undefined {
  const parts = tokens(script);
  for (let i = parts.length - 1; i >= 0; i--) {
    const runner = RUNNERS.get(nameOf(parts[i]));
    if (runner === undefined) continue;
    const words = parts
      .slice(i + 1)
      .map((text): Word => ({text, dynamic: false}));
    return {runner, words: [...words, ...rest]};
  }
  return undefined;
}

// Whether a word from an index on is `publish` (with npm, also a prefix of
// it), for positions that cannot be read. Built on first use, in one pass.
function publishedFrom(words: Word[]): (from: number, npm: boolean) => boolean {
  let publish: boolean[] | undefined;
  let prefix: boolean[] | undefined;
  return (from, npm) => {
    if (publish === undefined || prefix === undefined) {
      publish = new Array<boolean>(words.length + 1).fill(false);
      prefix = new Array<boolean>(words.length + 1).fill(false);
      for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i];
        publish[i] = publish[i + 1] || tokens(word.text).includes('publish');
        prefix[i] =
          prefix[i + 1] || (!isScript(word) && isNpmPublish(word.text));
      }
    }
    return publish[from] || (npm && prefix[from]);
  };
}

// Whether the segment's command searches or prints its arguments: `rg` without
// `--pre` (which runs a program on each file), `git grep` without
// `-O`/`--open-files-in-pager` (any `--o...` spelling), `grep`, `echo` or
// `printf`, after shell keywords and assignments only.
function isDataCommand(words: Word[]): boolean {
  const at = words.findIndex(
    word =>
      !SHELL_KEYWORDS.has(word.text) && !/^[A-Za-z_]\w*=/u.test(word.text),
  );
  const head = words[at];
  if (!head || head.dynamic) return false;
  const name = basename(head.text);
  const rest = words.slice(at + 1);
  if (PRINTERS.has(name)) return true;
  if (name === 'rg')
    return !rest.some(word => /^--pre(?:=|$)/u.test(word.text));
  if (SEARCHERS.has(name)) return true;
  return (
    name === 'git' &&
    rest[0]?.text === 'grep' &&
    !rest.some(word => /^(?:-O|--o)/u.test(word.text))
  );
}

// Whether a runner word starts a test run: `npm test`, `pnpm run test:unit`,
// `yarn vitest`, `npx jest`. Every reading of its subcommand must be one.
function isTestRun(words: Word[], runner: Runner, from: number): boolean {
  const found = positions(words, from, VALUE_OPTIONS[runner]);
  if (found === undefined || found.length === 0) return false;
  return found.every(at => {
    const name = programOf(words[at]);
    if (TEST_TOOLS.has(name)) return true;
    if (runner === 'npx' || runner === 'tool') return false;
    if (TEST_SUBCOMMANDS.has(name)) return true;
    if (!isRun(runner, name)) return false;
    const scripts = positions(words, at + 1, VALUE_OPTIONS[runner]);
    return (
      scripts !== undefined &&
      scripts.length > 0 &&
      scripts.every(script => CHECK_SCRIPT.test(literal(words[script])))
    );
  });
}

// Whether a segment publishes. `runsOutput` reports whether the command line
// may run text a command prints (a substitution or a pipe into a shell).
function publishes(
  words: Word[],
  depth: number,
  runsOutput: () => boolean,
): boolean {
  if (depth > MAX_DEPTH) return true;
  if (tooLarge(words)) return largePublishes(words);
  if (isInfoForm(words)) return false;
  if (isDataCommand(words) && !runsOutput()) return false;

  const read = reader(words, publishedFrom(words));

  let runner = false;
  let takesScripts = false;
  // In a test run, words after `--` and test-name values are data.
  let testRun = false;
  let dataRest = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (testRun && !dataRest && word.text === '--') dataRest = true;
    if (dataRest || (testRun && TEST_NAME.test(words[i - 1]?.text ?? '')))
      continue;
    if (isScript(word) && (runner || takesScripts)) {
      // `--call=script` and `-cscript` carry the script after the option.
      const bare = word.text.replace(/^(?:--call=|-c=?)/u, '');
      if (scriptPublishes(word.text, depth, runsOutput)) return true;
      if (bare !== word.text && scriptPublishes(bare, depth, runsOutput))
        return true;
      const joined = carried(word.text, words.slice(i + 1));
      if (joined) {
        runner = true;
        if (reader(joined.words, () => true)(joined.runner, 0)) return true;
      }
    }

    const name = runnerOf(word);
    if (name) {
      runner = true;
      if (read(name, i + 1)) return true;
      if (isTestRun(words, name, i + 1)) testRun = true;
    }
    if (!word.dynamic && SCRIPT_TAKERS.has(basename(word.text)))
      takesScripts = true;
  }

  return false;
}

// Whether a command line may run what a command prints: a command or
// process substitution, or a pipe with a shell, `eval`, `source`, `xargs` or
// `parallel` anywhere after it. Read from the raw text, quotes included.
const SUBSTITUTION = /\$\(|`|[<>]\(/u;
const RUNS_INPUT =
  /(?<![\w.-])(?:(?:ba|z|da|k|mk|y|c|tc|a)?sh|fish|eval|source|exec|xargs|parallel|\.)(?![\w.-])/u;

export function runsOutput(command: string): boolean {
  if (SUBSTITUTION.test(command)) return true;
  const pipe = command.indexOf('|');
  return pipe >= 0 && RUNS_INPUT.test(command.slice(pipe));
}

// `segment` is one simple command of `command`.
export function classifyPublish(
  segment: Word[],
  runsCommandOutput: () => boolean = () => true,
): Decision[] {
  return publishes(segment, 0, runsCommandOutput) ? [PUBLISHES] : [];
}
