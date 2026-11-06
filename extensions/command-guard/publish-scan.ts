import {basename} from 'node:path';
import type {Word} from './shell.ts';

// How the publish classifier reads a command's words.

export function literal(word: Word | undefined): string {
  return !word || word.dynamic ? '' : word.text;
}

// `lerna@7` and `@changesets/cli@2` name the program `lerna` and the changesets CLI.
export function nameOf(text: string): string {
  const name = text.replace(/(?<=.)@[^/@]*$/u, '');
  return name === '@changesets/cli' ? 'changeset' : basename(name);
}

export function programOf(word: Word): string {
  return nameOf(literal(word));
}

// npm accepts any unambiguous prefix of a command name: `npm pu` publishes.
export function isNpmPublish(name: string): boolean {
  return name.length >= 2 && 'publish'.startsWith(name);
}

// A word that holds more than one word, such as the script of `npx -c`.
export function isScript(word: Word): boolean {
  return /[\s;&|()<>`$"'\\]/u.test(word.text);
}

// The words of a text, split where a shell would split a command.
export function tokens(text: string): string[] {
  return text.split(/[^\w@./-]+/u).filter(Boolean);
}
