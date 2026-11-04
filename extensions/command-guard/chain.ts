import {basename} from 'node:path';
import {curlWrites, curlrcRisky, isCurlDownload} from './curl.ts';
import {isSafe, filters} from './safe.ts';
import {isFed} from './stdin.ts';
import type {Word} from './shell.ts';
import {carriesCommand} from './carrier.ts';

// EL-115 PR6 chain gate (Sophie's rulings). The seven class exemptions may
// loosen a command only when it is provably safe: every simple command is a
// bare, literal class atom or on SAFE below, nothing expands, substitutes,
// runs a nested shell, pipes into anything but a fixed text filter, or
// writes through a redirection. Otherwise the parser adds `__chain_unsafe__`
// and an ask rule keeps main's verdict.

// Expansion, substitution, heredocs and here-strings outside single quotes;
// device and proc paths; input redirected from outside the repository.
const RISKY_TEXT =
  /[$`]|[<>]\(|<<|(?<!>\s*)\/dev\/(?!null(?![\w/.-]))|>\s*\/dev\/(?!(?:null|stdout|stderr)(?![\w/.-]))|\/proc\/|<\s*(?:[/~]|\.\.)/u;
// Steps that change what a relative path names (kept from 10df0fe's rules).
const MOVES_DIR =
  /(?<![\w./-])(?:cd|pushd|popd|chdir|chroot|source|eval)(?![\w.-])|(?:^|[;&|(\n{]|then|do|else)\s*(?:(?:builtin|command)\s+)?\.(?=\s)|\s-C(?![\w-])|--chdir/u;
export const SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'source',
]);
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nice',
  'nohup',
  'timeout',
  'sudo',
  'doas',
  'time',
  'builtin',
  'xargs',
  'stdbuf',
  'ionice',
  'setsid',
  'caffeinate',
  'chronic',
]);

const FLAGS_RM = /^(?:-[rRfv]+|--recursive|--force|--verbose)$/u;
const BUILD_DIR =
  /^(?:\.\/)?(?:dist|build|out|target|node_modules|\.next|coverage)$/u;
const PM = /^(?:npm|pnpm|yarn|bun)$/u;

// The seven exempt classes, spelled with the bare command name.
export function isClassAtom(words: string[]): boolean {
  const [head, ...args] = words;
  if (head === 'rm') {
    const flags = args.findIndex(arg => !FLAGS_RM.test(arg));
    return flags > 0 && args.slice(flags).every(arg => BUILD_DIR.test(arg));
  }
  if (head === 'curl') return isCurlDownload(args);
  if (PM.test(head))
    return /^(?:run )?(?:test|lint|check)[:-]migrat(?:e|ion|ions)$/u.test(
      args.join(' '),
    );
  if (head === 'gh') return args[0] === 'api' && args[1] === 'graphql';
  if (head !== 'git') return false;
  let i = 0;
  while (args[i] === '-C' && args[i + 1] && !args[i + 1].startsWith('-'))
    i += 2;
  const [sub, ...rest] = args.slice(i);
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

// What canonicalization may turn a command into: wrappers, assignments,
// paths and tool globals dropped. A class atom here but not in the bare
// spelling is a wrapped atom, which never earns an exemption.
export function normalize(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (
      /^[A-Za-z_]\w*=/u.test(word) ||
      /^-/u.test(word) ||
      /^\d+(?:\.\d+)?[smhd]?$/u.test(word)
    )
      i++;
    else if (WRAPPERS.has(basename(word))) i++;
    else break;
  }
  const [head = '', ...args] = words.slice(i);
  const tool = basename(head.replace(/^\\/u, ''));
  if (tool === 'gh')
    return [
      tool,
      ...args.filter(
        (arg, j) =>
          !/^(?:-R|--repo)(?:=|$)|^-R./u.test(arg) &&
          !/^(?:-R|--repo)$/u.test(args[j - 1] ?? ''),
      ),
    ];
  if (tool === 'git') {
    let j = 0;
    while (j < args.length && args[j].startsWith('-'))
      j +=
        /^(?:-[Cc]|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source))$/u.test(
          args[j],
        )
          ? 2
          : 1;
    return [tool, ...args.slice(j)];
  }
  return [tool, ...args];
}

export const classish = (words: string[]): boolean => {
  const plain = normalize(words);
  return (
    isClassAtom(plain) || (plain[0] === 'curl' && curlWrites(plain.slice(1)))
  );
};

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

const texts = (segment: Word[]): string[] => segment.map(word => word.text);

export function chainUnsafe(
  command: string,
  parsed: Word[][],
  expanded: Word[][],
  wroteOutput: boolean,
): boolean {
  const outside = unquoted(command);
  if (wroteOutput || outside === undefined || RISKY_TEXT.test(outside))
    return true;
  // Ruling 1: a nested shell or eval anywhere keeps main's verdict.
  if (expanded.length !== parsed.length) return true;
  const words = parsed.map(texts);
  if (
    words.some(
      list =>
        normalize(list)[0] === '.' ||
        list.some(word => SHELLS.has(basename(word))) ||
        carriesCommand(list),
    )
  )
    return true;
  if (
    words.some(
      list => (list[0] === 'rm' || list[0] === 'curl') && isClassAtom(list),
    ) &&
    MOVES_DIR.test(command)
  )
    return true;
  if (
    words.some(
      list =>
        normalize(list)[0] === 'curl' &&
        curlWrites(list.slice(1)) &&
        (!isClassAtom(list) || curlrcRisky()),
    )
  )
    return true;
  // Bare means as written: `\rm` or `r''m` decode to `rm` but are not bare.
  const written = command.replace(
    /\\[\s\S]|'[^']*'|"(?:[^"\\]|\\[\s\S])*"/gu,
    '_',
  );
  const heads = new Map<string, number>();
  for (const list of words)
    if (isClassAtom(list)) heads.set(list[0], (heads.get(list[0]) ?? 0) + 1);
  for (const [head, count] of heads) {
    const plain = new RegExp(`(?:^|[;&|(\\n])[ \\t]*${head}(?=[ \\t]|$)`, 'gu');
    if ((written.match(plain)?.length ?? 0) < count) return true;
  }
  for (let i = 0; i < parsed.length; i++) {
    const segment = parsed[i];
    if (segment.length === 0) continue;
    // Arguments may hold a glob or braces; `$` and backticks were refused above.
    if (segment[0].dynamic) return true;
    if (parsed.length > 1 && isFed(segment) && !filters(words[i])) return true;
  }
  // Ruling 2: alone, a wrapped or path-qualified atom keeps main's verdict.
  if (parsed.length <= 1)
    return words.some(list => !isClassAtom(list) && classish(list));
  return !words.every(
    list => list.length === 0 || isClassAtom(list) || isSafe(list),
  );
}
