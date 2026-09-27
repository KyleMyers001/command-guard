// Bounded decoding of literal shell words. This is not a shell interpreter:
// it recognizes quoting, escapes, command separators, redirections,
// substitutions and here-documents well enough to tell what a command's
// literal arguments are, and marks everything else as dynamic.

export interface Word {
  // The word with quoting removed. Expansions are kept as written.
  text: string;
  // True when the shell could turn the word into something else: a variable,
  // substitution, glob, brace expansion, or an unterminated quote.
  dynamic: boolean;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

// Nesting this deep is never legitimate; the guard fails closed on the error.
const MAX_DEPTH = 8;

// Every simple command in the text, including those inside substitutions.
export function parseSegments(command: string): Word[][] {
  const segments: Word[][] = [];
  scanCommands(command, 0, undefined, segments, 0);
  return segments;
}

// Scans commands until `closer` (`)` or a backtick) or the end of the text,
// appending each simple command to `out`. Returns the index after the closer.
function scanCommands(
  text: string,
  start: number,
  closer: ')' | '`' | undefined,
  out: Word[][],
  depth: number,
): number {
  if (depth > MAX_DEPTH) throw new Error('Shell nesting too deep');

  let segment: Word[] = [];
  let word: Word | undefined;
  // What the next finished word is, other than an argument.
  let redirect: 'none' | 'target' | 'heredoc' = 'none';
  let stripTabs = false;
  let heredocs: Heredoc[] = [];
  let openParens = 0;

  const current = (): Word => (word ??= {text: '', dynamic: false});

  function endWord(): void {
    if (!word) return;

    if (redirect === 'heredoc')
      heredocs.push({delimiter: word.text, stripTabs});
    else if (redirect === 'none') segment.push(word);

    redirect = 'none';
    word = undefined;
  }

  function endSegment(): void {
    endWord();
    redirect = 'none';
    if (segment.length > 0) out.push(segment);
    segment = [];
  }

  function substitution(from: number, end: ')' | '`'): number {
    current().dynamic = true;
    return scanCommands(text, from, end, out, depth + 1);
  }

  let i = start;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '\\') {
      // A backslash-newline is a continuation, not a character.
      if (next === '\n') i += 2;
      else if (next === '\r' && text[i + 2] === '\n') i += 3;
      else {
        current().text += next ?? '';
        i += 2;
      }
    } else if (char === "'") {
      const close = text.indexOf("'", i + 1);
      current().text += text.slice(i + 1, close < 0 ? text.length : close);
      if (close < 0) current().dynamic = true;
      i = close < 0 ? text.length : close + 1;
    } else if (char === '"') {
      i = scanDoubleQuoted(text, i + 1, current(), out, depth);
    } else if (char === '$' && next === '(') {
      i = substitution(i + 2, ')');
    } else if (char === '`') {
      if (closer === '`') {
        endSegment();
        return i + 1;
      }
      i = substitution(i + 1, '`');
    } else if (char === '(') {
      endSegment();
      openParens++;
      i++;
    } else if (char === ')') {
      endSegment();
      if (closer === ')' && openParens === 0) return i + 1;
      openParens = Math.max(0, openParens - 1);
      i++;
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      // A number directly before the operator is a file descriptor.
      if (word && /^\d+$/u.test(word.text)) word = undefined;
      endWord();

      let operator = '';
      while (i < text.length && '<>&|'.includes(text[i])) operator += text[i++];

      const isHeredoc = operator === '<<';
      stripTabs = isHeredoc && text[i] === '-';
      if (stripTabs) i++;
      redirect = isHeredoc ? 'heredoc' : 'target';
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      endSegment();
      i++;
      if (char === '\n' && heredocs.length > 0) {
        i = skipHeredocs(text, i, heredocs);
        heredocs = [];
      }
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      i++;
    } else if (char === '#' && !word) {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline;
    } else {
      if ('$*?[{'.includes(char)) current().dynamic = true;
      current().text += char;
      i++;
    }
  }

  endSegment();
  return text.length;
}

// Appends a double-quoted string's contents to `word`. Returns the index
// after the closing quote.
function scanDoubleQuoted(
  text: string,
  start: number,
  word: Word,
  out: Word[][],
  depth: number,
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
      word.dynamic = true;
      i = scanCommands(text, i + 2, ')', out, depth + 1);
    } else if (char === '`') {
      word.dynamic = true;
      i = scanCommands(text, i + 1, '`', out, depth + 1);
    } else {
      if (char === '$') word.dynamic = true;
      word.text += char;
      i++;
    }
  }

  // Unterminated: the shell would keep reading, so the word is not known.
  word.dynamic = true;
  return text.length;
}

// Here-document bodies are data. Returns the index after the last body.
function skipHeredocs(
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
