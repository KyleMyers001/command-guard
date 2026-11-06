// Commands that may share a chain with an exempt command (exemptions.ts).
// Each is bare, with literal arguments and only the flags listed here; a
// chain holding anything else keeps every ask.

const PM = /^(?:npm|pnpm|yarn|bun)$/u;
// Repo-relative literal paths: no absolute path, `..`, `~` or option.
const relative = (arg: string): boolean =>
  /^[\w.+=,%@][\w.+=,%@/-]*$/u.test(arg) && !arg.split('/').includes('..');
const REV = /^(?!\/)[\w.^~@{}/-]+$/u;
// Each reader's exact flags; arguments are files.
const READER_FLAGS: Record<string, RegExp> = {
  cat: /^$/u,
  wc: /^-l$/u,
  grep: /^-[inrEF]$/u,
  sort: /^-[rnu]$/u,
  ls: /^-[la1]+$/u,
};
const GIT_FLAGS: Record<string, Set<string>> = {
  status: new Set(['-s', '--short', '-b', '--branch', '--porcelain']),
  diff: new Set([
    '--stat',
    '--cached',
    '--staged',
    '--name-only',
    '--name-status',
    '--check',
    '--shortstat',
    '--numstat',
  ]),
  log: new Set(['--oneline', '--stat', '--graph', '--decorate', '-p']),
  show: new Set(['--stat', '--name-only', '--name-status', '--oneline']),
};

function safeReader(head: string, args: string[]): boolean {
  if (head === 'head' || head === 'tail') {
    const files =
      args[0] === '-n' && /^\d+$/u.test(args[1] ?? '') ? args.slice(2) : args;
    return files.every(relative);
  }
  if (head === 'jq')
    return (
      args.length > 0 &&
      /^[.\w[\]|, ]+$/u.test(args[0]) &&
      !/\b(?:env|input\w*|import|include|getpath|\$__loc__)\b/u.test(args[0]) &&
      args.slice(1).every(relative)
    );
  const flags = READER_FLAGS[head];
  if (!flags) return false;
  // Walk an index: slicing per flag is quadratic on thousands of flags.
  let at = 0;
  while (at < args.length && args[at].startsWith('-') && flags.test(args[at]))
    at++;
  if (head === 'grep') {
    // The first non-flag word is the pattern; without one, `-` is not a path.
    if (args[at] && !args[at].startsWith('-')) at++;
    else return false;
  }
  for (; at < args.length; at++) if (!relative(args[at])) return false;
  return true;
}

function safeGit(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (sub === 'fetch')
    return (
      rest.length === 0 ||
      (rest.length === 1 && /^[A-Za-z][\w.-]*$/u.test(rest[0]))
    );
  const flags = GIT_FLAGS[sub];
  if (!flags) return false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (sub === 'log' && arg === '-n' && /^\d+$/u.test(rest[i + 1] ?? '')) i++;
    else if (sub === 'log' && /^-\d+$/u.test(arg)) continue;
    else if (
      arg.startsWith('-') ? !flags.has(arg) : sub === 'status' || !REV.test(arg)
    )
      return false;
  }
  return true;
}

export function isSafe(words: string[]): boolean {
  const [head, ...args] = words;
  if (head === 'cd') return true;
  // printf is not safe: its format string expands. echo passes only with
  // literal words: no option (-e decodes) and no backslash escape. Unquoted
  // `~`, globs and other shell-special characters are checked in gate.ts.
  if (head === 'echo')
    return args.every(arg => !arg.startsWith('-') && !arg.includes('\\'));
  if (head === 'pwd' || head === 'true') return args.length === 0;
  if (head === 'mkdir')
    return args[0] === '-p' && args.length > 1 && args.slice(1).every(relative);
  if (PM.test(head))
    return (
      args.length === 2 &&
      args[0] === 'run' &&
      /^(?:build|test|lint|typecheck|check)$/u.test(args[1])
    );
  if (head === 'git') return safeGit(args);
  return safeReader(head, args);
}

// The right side of a pipe (or an input redirection) may only be a filter.
const FILTERS = new Set(['grep', 'head', 'tail', 'wc', 'sort', 'cat']);
export const filters = (words: string[]): boolean =>
  FILTERS.has(words[0]) &&
  isSafe(words) &&
  (words[0] !== 'cat' || words.length === 1);
