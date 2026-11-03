import {basename} from 'node:path';
import type {Word} from './shell.ts';

// How the publish classifier reads a command's words: which can be the
// subcommand or program once options are skipped.

export function literal(word: Word | undefined): string {
  return !word || word.dynamic ? '' : word.text;
}

// Indexes where the first non-option word may be. A dynamic word, or an option
// whose value is unknown, is counted both ways. A flag in `info`, reached as
// an option, ends the command (npm prints help and stops), so the path dies;
// the same word consumed as another option's value is not one.
export function firstWords(
  args: Word[],
  valued: Set<string>,
  info?: Set<string>,
): number[] {
  const found = new Set<number>();
  const seen = new Set<number>();
  const todo = [0];

  for (let i = todo.pop(); i !== undefined; i = todo.pop()) {
    if (i >= args.length || seen.has(i)) continue;
    seen.add(i);
    const {text, dynamic} = args[i];

    if (text === '--') found.add(i + 1);
    else if (dynamic) {
      found.add(i);
      todo.push(i + 1);
    } else if (info?.has(text)) continue;
    else if (!text.startsWith('-') || text === '-') found.add(i);
    else if (text.includes('=')) todo.push(i + 1);
    else if (valued.has(text)) todo.push(i + 2);
    else todo.push(i + 1, i + 2);
  }

  return [...found].filter(i => i < args.length);
}

// Whether `publish` can be the script name or subcommand at the start of args.
export function startsWithPublish(args: Word[], valued: Set<string>): boolean {
  return firstWords(args, valued).some(i => literal(args[i]) === 'publish');
}

// `lerna@7` and `@changesets/cli@2` name the program `lerna` and the changesets CLI.
export function programOf(word: Word): string {
  const name = literal(word).replace(/(?<=.)@[^/@]*$/u, '');
  return name === '@changesets/cli' ? 'changeset' : basename(name);
}

export function npmCommand(name: string): string {
  // npm accepts any unambiguous prefix of a command name: `npm pu` publishes.
  if (name.length >= 2 && 'publish'.startsWith(name)) return 'publish';
  return name.length >= 5 && name.startsWith('run-') ? 'run-script' : name;
}
