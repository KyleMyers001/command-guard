import {basename} from 'node:path';
import type {Word} from './shell.ts';

// Programs that run the rest of their arguments as a command.
const PREFIXES = new Set([
  'sudo',
  'doas',
  'nohup',
  'command',
  'exec',
  'nice',
  'ionice',
  'timeout',
  'xargs',
  'stdbuf',
  'setsid',
]);

export function isPrefix(word: Word | undefined): boolean {
  return (
    word !== undefined && !word.dynamic && PREFIXES.has(basename(word.text))
  );
}
