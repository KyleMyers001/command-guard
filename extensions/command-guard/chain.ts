import {isFed} from './stdin.ts';
import type {Word} from './shell.ts';

// EL-115 PR6 chain gate (allowlist). The exemptions for the seven classes may
// loosen a command only when every simple command in it is a class atom or on
// SAFE below, and nothing in it expands, substitutes, pipes into anything but
// a fixed text filter, or writes through a redirection. Otherwise the parser
// adds `__chain_unsafe__` and an ask rule keeps main's verdict. A single
// command needs only the second half: alone, it cannot borrow an exemption.

// Expansion, substitution, heredocs and here-strings outside single quotes.
const RISKY_TEXT = /[$`]|[<>]\(|<</u;

const FLAGS_RM = /^(?:-[rRfv]+|--recursive|--force|--verbose)$/u;
const BUILD_DIR =
  /^(?:\.\/)?(?:dist|build|out|target|node_modules|\.next|coverage)$/u;
const CURL_WORD =
  /^(?:-[sSLf]+|--(?:silent|show-error|location|fail|fail-with-body|compressed))$/u;
const CURL_VALUE = /^(?:--retry|--max-time|-m|--connect-timeout)$/u;
const URL = /^https?:\/\/[\w.~:/?#%=+@,-]+$/u;
// No `@`: a curl value naming a file to send is never part of an atom.
const PATH = /^\/dev\/null$|^(?:\/tmp\/|\.\/)?[\w%+=,][\w.%+=,~/-]*$/u;
const PM = /^(?:npm|pnpm|yarn|bun)$/u;

const texts = (words: Word[]): string[] => words.map(word => word.text);
const tool = (text: string, name: string): boolean =>
  ['', '/bin/', '/usr/bin/', '\\'].some(prefix => text === prefix + name);

// `git [-C <literal>]... <sub> ...`, returning the subcommand and its args.
function gitSub(words: string[]): [string, string[]] | undefined {
  if (!tool(words[0], 'git')) return undefined;
  let i = 1;
  while (words[i] === '-C' && words[i + 1] && !words[i + 1].startsWith('-'))
    i += 2;
  return words[i] === undefined ? undefined : [words[i], words.slice(i + 1)];
}

function isCurlDownload(args: string[]): boolean {
  let output = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (CURL_WORD.test(arg) || URL.test(arg)) continue;
    if (CURL_VALUE.test(arg) && /^\d+$/u.test(args[i + 1] ?? '')) i++;
    else if (
      /^-[sSLf]*o$|^--output$/u.test(arg) &&
      PATH.test(args[i + 1] ?? '')
    ) {
      output = true;
      i++;
    } else if (/^--output=/u.test(arg) && PATH.test(arg.slice(9)))
      output = true;
    else return false;
  }
  return output;
}

// The seven exempt classes, in the shapes their ask rules exempt (or wider:
// the rules still decide; this only stops other commands riding along).
export function isClassAtom(words: string[]): boolean {
  const [head, ...args] = words;
  if (tool(head, 'rm')) {
    const flags = args.findIndex(arg => !FLAGS_RM.test(arg));
    return flags > 0 && args.slice(flags).every(arg => BUILD_DIR.test(arg));
  }
  if (tool(head, 'curl')) return isCurlDownload(args);
  if (PM.test(head))
    return /^(?:run )?(?:test|lint|check)[:-]migrat(?:e|ion|ions)$/u.test(
      args.join(' '),
    );
  if (head === 'gh') return args[0] === 'api' && args[1] === 'graphql';
  const git = gitSub(words);
  if (!git) return false;
  const [sub, rest] = git;
  if (sub === 'merge') return true;
  if (sub === 'checkout')
    return (
      rest.includes('--detach') &&
      !rest.some(arg => /^(?:-[bB]|--orphan|-f|--force|--)$/u.test(arg))
    );
  if (sub !== 'config') return false;
  const read = rest.filter(
    arg =>
      !/^(?:--(?:global|local|system|worktree|show-origin|show-scope|null)|-z)$/u.test(
        arg,
      ),
  );
  return (
    (read.length === 2 && /^--get(?:-all|-regexp)?$/u.test(read[0])) ||
    (read.length === 1 &&
      /^(?:--list|-l|[A-Za-z][\w-]*\.[\w.*-]+)$/u.test(read[0]))
  );
}

const READERS = new Set(['grep', 'head', 'tail', 'wc', 'sort', 'jq', 'cat']);
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'fetch']);
// Git options that write files or run programs.
const GIT_RISKY =
  /^(?:--output|--ext-diff|--textconv|--upload-pack|-u$|--exec|--open-files-in-pager|-O)/u;

// Sophie's safe list (2:41 AM ruling), each with literal arguments only.
export function isSafe(words: string[]): boolean {
  const [head, ...args] = words;
  if (['cd', 'ls', 'pwd', 'true', 'echo', 'printf'].includes(head)) return true;
  if (head === 'mkdir') return args[0] === '-p' && args.length > 1;
  if (READERS.has(head)) return true;
  if (PM.test(head))
    return (
      args.length === 2 &&
      args[0] === 'run' &&
      /^(?:build|test|lint|typecheck|check)$/u.test(args[1])
    );
  const git = words[0] === 'git' ? gitSub(words) : undefined;
  return (
    git !== undefined &&
    words[1] !== '-C' &&
    GIT_READS.has(git[0]) &&
    !git[1].some(arg => GIT_RISKY.test(arg))
  );
}

// The right side of a pipe (or an input redirection) may only be a filter.
const FILTERS = new Set(['grep', 'head', 'tail', 'wc', 'sort']);
const filters = (segment: Word[]): boolean =>
  FILTERS.has(segment[0].text) ||
  (segment[0].text === 'cat' && segment.length === 1);

// The text outside single quotes, or undefined when a quote is left open.
function unquoted(text: string): string | undefined {
  let quote = '';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") quote = char === "'" ? '' : quote;
    else if (char === '\\') i++;
    else if (char === "'" && quote === '') quote = char;
    else {
      if (char === '"') quote = quote === '"' ? '' : '"';
      out += char;
    }
  }
  return quote === '' ? out : undefined;
}

export function chainUnsafe(
  command: string,
  segments: Word[][],
  wroteOutput: boolean,
): boolean {
  const outside = unquoted(command);
  if (wroteOutput || outside === undefined || RISKY_TEXT.test(outside))
    return true;
  for (const segment of segments) {
    if (segment.length === 0) continue;
    // Arguments may hold a glob or braces; `$` and backticks were refused above.
    if (segment[0].dynamic) return true;
    // Input into a lone command (`<> /dev/null`) cannot reach another one.
    if (segments.length > 1 && isFed(segment) && !filters(segment)) return true;
  }
  if (segments.length <= 1) return false;
  return !segments.every(segment => {
    const words = texts(segment);
    return isClassAtom(words) || isSafe(words);
  });
}
