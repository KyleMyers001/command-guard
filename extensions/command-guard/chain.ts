import {basename} from 'node:path';
import {curlWrites, isCurlDownload} from './curl.ts';

// EL-115 PR6 class atoms: the seven exemptions, spelled with the bare
// command name, and the normalization that reveals wrapped spellings.
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
