import {isPublicUrl, isRepoOutput} from './curl.ts';
import type {Word} from './shell.ts';

// The harmless commands that run without a prompt although a `main` ask rule
// matches them. This file is the only definition of their grammar. Each one
// is positive: any word, option, quoting or expansion outside it keeps the
// ask. Whether a whole command may use them is decided in gate.ts.

export type ExemptClass =
  'rm' | 'merge' | 'config' | 'checkout' | 'graphql' | 'curl' | 'migrate';

// A word written exactly as it reads: no quoting, escape, continuation,
// expansion, glob, space, control or non-ASCII character.
const plain = (word: Word | undefined): word is Word =>
  word !== undefined &&
  !word.dynamic &&
  word.raw === word.text &&
  /^[\x21-\x7e]+$/u.test(word.text);

// A literal word that may be quoted, but holds no backslash (escape or
// continuation), expansion or control character.
const literal = (word: Word): boolean =>
  !word.dynamic &&
  word.raw !== undefined &&
  !word.raw.includes('\\') &&
  ![...word.text].some(char => char < ' ' || char === '\x7f');

// `rm` with only recursive, force and verbose flags, then build directories
// named bare (optionally `./`): no path, `..`, glob or trailing slash. GNU
// `rm -rf link/` empties a symlink's target and `rm -rf a/dist` can cross a
// symlinked ancestor, so neither is exempt.
const RM_FLAG = /^(?:-[rRfv]+|--recursive|--force|--verbose)$/u;
const BUILD_DIR =
  /^(?:\.\/)?(?:dist|build|out|target|node_modules|\.next|coverage)$/u;

function isBuildDirRemoval(args: Word[]): boolean {
  const dirs = args.findIndex(arg => !RM_FLAG.test(arg.text));
  return (
    dirs > 0 &&
    args.every(plain) &&
    args.slice(dirs).every(arg => BUILD_DIR.test(arg.text))
  );
}

// Git's arguments from the subcommand on, when the only options before it
// are `-C` with a plain literal path (no `~`, which the shell expands).
function afterGitDirs(args: Word[]): Word[] | undefined {
  let i = 0;
  while (args[i]?.text === '-C') {
    const dir = args[i + 1];
    if (!plain(args[i]) || !plain(dir) || /^-|~/u.test(dir.text))
      return undefined;
    i += 2;
  }
  return args.slice(i);
}

// A local merge. `--no-verify` (and any `--no-v...` spelling) skips hooks.
function isMerge(args: Word[]): boolean {
  return (
    args.every(literal) && !args.some(arg => arg.text.startsWith('--no-v'))
  );
}

// A `git config` read: scope options, then `--get`/`--get-all`/
// `--get-regexp <key>`, `--list`/`-l`, or a bare `section.key`.
const CONFIG_SCOPE =
  /^(?:--global|--local|--system|--worktree|--show-origin|--show-scope|-z|--null)$/u;

function isConfigRead(args: Word[]): boolean {
  if (!args.every(plain)) return false;
  const words = args.map(arg => arg.text);
  let i = 0;
  while (CONFIG_SCOPE.test(words[i] ?? '')) i++;
  const read = words.slice(i);
  return (
    (read.length === 2 &&
      /^--get(?:-all|-regexp)?$/u.test(read[0]) &&
      /^[A-Za-z][\w.*-]*$/u.test(read[1])) ||
    (read.length === 1 &&
      /^(?:--list|-l|[A-Za-z][\w-]*\.[\w.*-]+)$/u.test(read[0]))
  );
}

// `checkout --detach` without branch creation, force or `--`. Git refuses
// `--detach` with a path, so it cannot overwrite files; git.ts decides the
// rest (known directory, no dynamic word) and marks the ask exemptible.
function isDetach(args: Word[]): boolean {
  return (
    args.every(literal) &&
    args.some(arg => arg.text === '--detach') &&
    !args.some(arg => /^(?:-[bB]|--orphan|-f|--force|--)$/u.test(arg.text))
  );
}

// `gh api graphql` with a literal single-quoted query and simple variables.
// The query may not read a file (`@`) or fill a `{owner}`, `{repo}` or
// `{branch}` placeholder. Any other option asks, and so does any mention of
// `mutation` in the command (checked in gate.ts).
const FIELD = /^(?:-[fF]|--raw-field|--field)$/u;
const QUERY = /^query='[^']*'$|^'query=[^']*'$/u;
const VARIABLE =
  /^[A-Za-z_]\w*='[\w./:{} -]*'$|^[A-Za-z_]\w*=[\w./:{}-]*$|^'[A-Za-z_]\w*=[\w./:{} -]*'$/u;
const JQ = /^'[^']*'$|^[\w.[\]-]+$/u;

function isGraphqlQuery(args: Word[]): boolean {
  const [api, graphql] = args;
  if (!plain(api) || api.text !== 'api') return false;
  if (!plain(graphql) || graphql.text !== 'graphql' || args.length < 3)
    return false;
  for (let i = 2; i < args.length; i++) {
    const option = args[i];
    const value = args[i + 1];
    const raw = value && !value.dynamic ? (value.raw ?? '') : '';
    if (!plain(option)) return false;
    if (/^--(?:paginate|slurp|silent)$/u.test(option.text)) continue;
    if (FIELD.test(option.text) && QUERY.test(raw)) {
      const query = value.text.slice('query='.length);
      if (query.startsWith('@') || /\{(?:owner|repo|branch)\}/u.test(query))
        return false;
    } else if (FIELD.test(option.text) && VARIABLE.test(raw)) {
      if (/^'?query=/u.test(raw)) return false;
    } else if (option.text === '--cache' && plain(value)) {
      if (!/^\d+[smh]$/u.test(value.text)) return false;
    } else if (/^(?:--jq|-q)$/u.test(option.text) && JQ.test(raw)) {
      // A filter is output formatting only.
    } else return false;
    i++;
  }
  return true;
}

// `curl [quiet flags] -o <repo file> <public url>`, see curl.ts. The URL
// may be wholly quoted; every other word is plain.
const CURL_FLAG =
  /^(?:-[sSLf]+|--(?:silent|show-error|location|fail|fail-with-body|compressed))$/u;
const CURL_VALUE = /^(?:--retry|--max-time|-m|--connect-timeout)$/u;
const QUOTED_URL = /^'[^'\s$`\\]*'$|^"[^"\s$`\\]*"$/u;

function isDownload(args: Word[]): boolean {
  let output = false;
  let url = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    const value = args[i + 1];
    if (
      !word.dynamic &&
      isPublicUrl(word.text) &&
      (QUOTED_URL.test(word.raw ?? '') || plain(word))
    ) {
      url = true;
      continue;
    }
    if (!plain(word)) return false;
    if (CURL_FLAG.test(word.text)) continue;
    if (CURL_VALUE.test(word.text) && plain(value) && /^\d+$/u.test(value.text))
      i++;
    else if (
      /^-[sSLf]*o$|^--output$/u.test(word.text) &&
      plain(value) &&
      isRepoOutput(value.text)
    ) {
      output = true;
      i++;
    } else if (
      word.text.startsWith('--output=') &&
      isRepoOutput(word.text.slice('--output='.length))
    )
      output = true;
    else return false;
  }
  return output && url;
}

// A package script that checks migrations, with no arguments.
const PACKAGE_MANAGER = /^(?:npm|pnpm|yarn|bun)$/u;
const MIGRATION_CHECK = /^(?:test|lint|check)[:-]migrat(?:e|ion|ions)$/u;

function isMigrationCheck(args: Word[]): boolean {
  const words = args.map(arg => arg.text);
  const script = words[0] === 'run' ? words.slice(1) : words;
  return (
    args.every(plain) && script.length === 1 && MIGRATION_CHECK.test(script[0])
  );
}

// The class of a simple command whose program is named bare (no path,
// wrapper or assignment) and whose arguments fit an exemption.
export function exemptClass(words: Word[]): ExemptClass | undefined {
  const [head, ...args] = words;
  if (!plain(head)) return undefined;
  if (head.text === 'rm') return isBuildDirRemoval(args) ? 'rm' : undefined;
  if (head.text === 'curl') return isDownload(args) ? 'curl' : undefined;
  if (head.text === 'gh') return isGraphqlQuery(args) ? 'graphql' : undefined;
  if (PACKAGE_MANAGER.test(head.text))
    return isMigrationCheck(args) ? 'migrate' : undefined;
  if (head.text !== 'git') return undefined;

  const [sub, ...rest] = afterGitDirs(args) ?? [];
  if (!plain(sub)) return undefined;
  if (sub.text === 'merge') return isMerge(rest) ? 'merge' : undefined;
  if (sub.text === 'config') return isConfigRead(rest) ? 'config' : undefined;
  if (sub.text === 'checkout') return isDetach(rest) ? 'checkout' : undefined;
  return undefined;
}
