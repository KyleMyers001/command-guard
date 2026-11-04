import {basename} from 'node:path';
import type {Word} from './shell.ts';
import {isFed} from './stdin.ts';

// EL-115 PR6 (Codex 4466554537): an environment dump piped into a network
// tool, in a command that also names a class word, keeps asking. This
// replaces a lookahead rule that re-scanned the text from every match; it
// walks the parsed segments once. A command that is only the pipeline
// itself keeps main's verdict, as before.
const NET = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
]);
const CLASS_WORD = /rm|gh|git|curl|migrat/u;

const WRAP = new Set([
  'command',
  'exec',
  'nice',
  'nohup',
  'timeout',
  'sudo',
  'doas',
  'time',
  'builtin',
  'stdbuf',
  'ionice',
  'setsid',
]);
const ENV_ARG = /^(?:-[0i]+|--null|-u|[A-Za-z_]\w*=.*)$/u;

// The command words after wrappers, options and assignments. `env` with
// nothing but its own options is the dump itself; otherwise a wrapper.
function head(segment: Word[]): string[] {
  const words = segment.map(word => basename(word.text));
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === 'env') {
      let j = i + 1;
      while (j < words.length && ENV_ARG.test(words[j])) j++;
      if (j === words.length) return ['env'];
      i = j;
    } else if (
      WRAP.has(word) ||
      /^[A-Za-z_]\w*=|^-|^\d+(?:\.\d+)?[smhd]?$/u.test(word)
    )
      i++;
    else break;
  }
  return words.slice(i);
}

function dumps(words: string[]): boolean {
  const [tool, ...args] = words;
  if (tool === 'env') return args.length === 0;
  if (tool === 'printenv') return true;
  if (tool === 'set') return true;
  if (tool === 'export') return args[0] === '-p';
  if (tool === 'declare') return /^-[a-zA-Z]*[xp]/u.test(args[0] ?? '');
  if (tool === 'compgen') return args[0] === '-e';
  return false;
}

export function envDumpExfil(command: string, parsed: Word[][]): boolean {
  if (!CLASS_WORD.test(command)) return false;
  const segments = parsed.filter(segment => segment.length > 0);
  for (let i = 0; i < segments.length; i++) {
    if (!dumps(head(segments[i]))) continue;
    // Follow the pipeline to its end; ask if a network tool reads it.
    let j = i + 1;
    let sends = false;
    while (j < segments.length && isFed(segments[j])) {
      if (NET.has(head(segments[j])[0] ?? '')) sends = true;
      j++;
    }
    if (sends && !(i === 0 && j === segments.length)) return true;
  }
  return false;
}
