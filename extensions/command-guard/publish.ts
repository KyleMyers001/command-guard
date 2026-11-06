import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import {INFO_FLAGS, SCRIPT_TAKERS, SHELL_KEYWORDS} from './publish-options.ts';
import {
  isNpmPublish,
  isScript,
  nameOf,
  programOf,
  tokens,
} from './publish-scan.ts';
import {unwrap} from './scripts.ts';
import {parseSegments, type Word} from './shell.ts';

// Package publishing is hard to undo, so it is always denied. The rule is
// blunt and reads neither option grammar nor wrappers: when a segment has an
// npm, pnpm, yarn, npx, lerna or changesets word (also `name@version` or a
// path), any later word that is `publish` (or an npm prefix such as `pub`) is
// a publish, whatever sits between them. A quoted word after a program that
// runs scripts (`sh -c`, `su -c`, `eval`) is read as a script the same way.
// This also denies `echo npm publish`, which the raw rule denies too. Only
// help and version output is left alone, where npm is the command itself:
// `npm help publish`, `npm -h publish`.

const PUBLISHES: Decision = {
  verdict: 'deny',
  reason:
    'package publish (npm, pnpm, yarn, lerna or changesets, including workspace and script forms) cannot be undone',
  advice:
    'Inspect the package with `npm pack --dry-run`, and publish from CI or a terminal outside Pi.',
};

const RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'lerna',
  'changeset',
  'npx',
  'pnpx',
  'pn',
  'pnx',
  'yarnpkg',
]);
// Levels of script in a script. Past this the command is denied, as it is
// when it is too large to read and has a runner word and `publish` text.
const MAX_DEPTH = 3;
const MAX_WORDS = 1000;
const MAX_CHARS = 8192;

// The runner a word names, or '' when it is not one.
function runnerOf(word: Word): string {
  if (word.dynamic || isScript(word)) return '';
  const name = programOf(word);
  return RUNNERS.has(name) ? name : '';
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

// Whether the text of a script, such as the value of `sh -c`, publishes.
function scriptPublishes(script: string, depth: number): boolean {
  return parseSegments(script).some(segment => publishes(segment, depth + 1));
}

// Whether a segment publishes. Linear in its words: one pass, no slices.
function publishes(words: Word[], depth: number): boolean {
  if (depth > MAX_DEPTH) return true;
  if (tooLarge(words)) return largePublishes(words);
  if (isInfoForm(words)) return false;

  let runner = false;
  let npm = false;
  let takesScripts = false;

  for (const word of words) {
    const script = isScript(word);

    if (runner && tokens(word.text).includes('publish')) return true;
    if (script && (runner || takesScripts)) {
      // `--call=script` and `-cscript` carry the script after the option.
      const bare = word.text.replace(/^(?:--call=|-c=?)/u, '');
      if (scriptPublishes(word.text, depth)) return true;
      if (bare !== word.text && scriptPublishes(bare, depth)) return true;
      // The taker joins its words, so a runner at the end of this script
      // runs a `publish` that follows: `ssh h 'a npm' publish`.
      for (const token of tokens(word.text)) {
        const name = nameOf(token);
        if (RUNNERS.has(name)) runner = true;
        if (name === 'npm') npm = true;
      }
    }
    if (npm && !script && isNpmPublish(word.text)) return true;

    const name = runnerOf(word);
    if (name) runner = true;
    if (name === 'npm') npm = true;
    if (!word.dynamic && SCRIPT_TAKERS.has(basename(word.text)))
      takesScripts = true;
  }

  return false;
}

// `segment` is one simple command.
export function classifyPublish(segment: Word[]): Decision[] {
  return publishes(segment, 0) ? [PUBLISHES] : [];
}
