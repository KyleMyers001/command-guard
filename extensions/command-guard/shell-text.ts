import type {ShellMode, Word} from './shell.ts';

// The pieces of the shell scanner that read text rather than commands.

export interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

// Appends a double-quoted string's contents to `word`; `scan` reads the
// commands of a substitution and returns the index after it. Returns the index
// after the closing quote.
export function scanDoubleQuoted(
  text: string,
  start: number,
  word: Word,
  scan: (from: number, closer: ')' | '`') => number,
  mode: ShellMode,
): number {
  let i = start;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') return i + 1;

    if (char === '\\' && next === '\n') {
      i += 2;
    } else if (char === '\\' && next !== undefined && '$`"\\'.includes(next)) {
      word.text += next;
      i += 2;
    } else if (char === '$' && next === '(') {
      word.dynamic = word.expands = true;
      i = scan(i + 2, ')');
    } else if (char === '`') {
      word.dynamic = word.expands = true;
      i = scan(i + 1, '`');
    } else {
      if (char === '$') word.dynamic = word.expands = true;
      word.text += char;
      i++;
    }
  }

  // Unterminated: the shell would keep reading, so the word is not known.
  word.dynamic = word.expands = true;
  mode.uncertain = true;
  return text.length;
}

// Here-document bodies are data. Returns the index after the last body.
export function skipHeredocs(
  text: string,
  start: number,
  heredocs: Heredoc[],
): number {
  let i = start;

  for (const {delimiter, stripTabs} of heredocs) {
    while (i < text.length) {
      const newline = text.indexOf('\n', i);
      const end = newline < 0 ? text.length : newline;
      const line = text.slice(i, end).replace(/\r$/u, '');
      i = newline < 0 ? text.length : newline + 1;

      if ((stripTabs ? line.replace(/^\t+/u, '') : line) === delimiter) break;
    }
  }

  return i;
}
