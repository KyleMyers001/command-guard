// EL-115 PR6 safe list (Sophie's rulings 3 and 4): commands that may share a
// chain with a class atom. Each is bare, with literal arguments and only the
// flags listed here; anything else keeps main's verdict.

const PM = /^(?:npm|pnpm|yarn|bun)$/u;
// Repo-relative literal paths: no absolute path, `..`, `~` or option.
const relative = (arg: string): boolean =>
  /^[\w.+=,%@][\w.+=,%@/-]*$/u.test(arg) && !arg.split('/').includes('..');
const REV = /^(?!\/)[\w.^~@{}/-]+$/u;
// Each reader's exact flags (Sophie's ruling 3); arguments are files.
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
  let rest = args;
  while (rest[0]?.startsWith('-') && flags.test(rest[0])) rest = rest.slice(1);
  if (head === 'grep')
    rest = rest[0] && !rest[0].startsWith('-') ? rest.slice(1) : ['-'];
  return rest.every(relative);
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

export function isSafe(words: string[], alone = false): boolean {
  const [head, ...args] = words;
  if (head === 'cd') return true;
  // Sophie (CR on 850ef37): printf is not safe in a chain (its format string
  // expands), so a chain holding one keeps main's verdict; alone it prints,
  // as before. In a chain echo passes
  // only with plain literal words: no option (-e decodes), no backslash escape.
  // Unquoted `~`, globs and other shell-special characters are checked in
  // gate.ts on the raw text.
  if (alone && head === 'echo') return true;
  if (alone && head === 'printf') return !args[0]?.startsWith('-');
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
