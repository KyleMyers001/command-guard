import {scanDoubleQuoted, skipHeredocs, type Heredoc} from './shell-text.ts';

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

// How the scanner reads a command. `legacy` switches off everything added
// since the guard's first splitter (process substitution), so the same text can
// be read both ways. `uncertain` is set when the text holds a construct the
// scanner cannot be sure about; callers then also use the legacy reading.
export interface ShellMode {
  legacy: boolean;
  uncertain: boolean;
}

// Operators the scanner knows. Anything else made of `<`, `>`, `&` and `|` is
// unusual enough to read both ways.
const KNOWN_OPERATORS = new Set('< > >> >| >& &> &>> << <<< <> <&'.split(' '));

// Nesting this deep is never legitimate; the guard fails closed on the error.
const MAX_DEPTH = 8;

// Every simple command in the text, including those inside substitutions.
export function parseSegments(
  command: string,
  mode: ShellMode = {legacy: false, uncertain: false},
): Word[][] {
  const segments: Word[][] = [];
  scanCommands(command, 0, undefined, segments, 0, mode);
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
  mode: ShellMode,
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

    // A case pattern ends with `)`, which the scanner would take for the end
    // of the substitution it sits in.
    if (
      word.text === 'case' &&
      !word.dynamic &&
      segment.length === 0 &&
      (depth > 0 || openParens > 0)
    ) {
      mode.uncertain = true;
    }

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
    return scanCommands(text, from, end, out, depth + 1, mode);
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
      if (close < 0) {
        current().dynamic = true;
        mode.uncertain = true;
      }
      i = close < 0 ? text.length : close + 1;
    } else if (char === '"') {
      i = scanDoubleQuoted(
        text,
        i + 1,
        current(),
        (from, end) => scanCommands(text, from, end, out, depth + 1, mode),
        mode,
      );
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
      if (openParens === 0) mode.uncertain = true;
      openParens = Math.max(0, openParens - 1);
      i++;
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      // A number directly before the operator is a file descriptor.
      if (word && /^\d+$/u.test(word.text)) word = undefined;
      endWord();

      let operator = '';
      while (i < text.length && '<>&|'.includes(text[i])) operator += text[i++];

      if (!mode.legacy) {
        if (!KNOWN_OPERATORS.has(operator)) mode.uncertain = true;

        // `>(...)` and `<(...)` hand the outer command a pipe, after whatever
        // redirect operator comes before it (`2>>(...)`, `>&>(...)`). The body
        // is a segment of its own; the pipe is a file name the outer command's
        // arguments never depend on, so it is left out and the outer command
        // carries on after it as if it were not there.
        if (/[<>]$/u.test(operator) && text[i] === '(') {
          mode.uncertain = true;
          i = scanCommands(text, i + 1, ')', out, depth + 1, mode);
          redirect = 'none';
          continue;
        }
      }

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
  // The text ended inside a substitution.
  if (closer) mode.uncertain = true;
  return text.length;
}
