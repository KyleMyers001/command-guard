import {
  scanDoubleQuoted,
  skipHeredocs as skipLegacyHeredocs,
} from './shell-text.ts';
import {type Heredoc, skipHeredocs} from './heredoc.ts';
import {isHarmlessOutput} from './redirect.ts';

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
  // True when an expansion other than a plain brace pair made it dynamic.
  expands?: boolean;
  // The word as written, quotes and escapes included, and where it starts in
  // the text that was scanned. Set by the scanner.
  raw?: string;
  start?: number;
}

// What the scanner learned about a command besides its words.
export interface Parsed {
  segments: Word[][];
  // Simple commands that read standard input: the right side of a pipe, or a
  // command with an input redirection, here-document, here-string or process
  // substitution.
  fed: Set<Word[]>;
  // Simple commands with any redirection or here-document.
  redirected: Set<Word[]>;
  // An output redirection other than one that only duplicates or closes a
  // file descriptor or writes to /dev/null, stderr or stdout.
  writesOutput: boolean;
}

// Uncertain scans are also checked with the original command splitter.
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
export function parseCommand(
  command: string,
  mode: ShellMode = {legacy: false, uncertain: false},
): Parsed {
  const parsed: Parsed = {
    segments: [],
    fed: new Set(),
    redirected: new Set(),
    writesOutput: false,
  };
  scanCommands(command, 0, undefined, parsed, 0, mode);
  return parsed;
}

export function parseSegments(command: string, mode?: ShellMode): Word[][] {
  return parseCommand(command, mode).segments;
}

// Scans commands until `closer` (`)` or a backtick) or the end of the text,
// appending each simple command to `out`. Returns the index after the closer.
function scanCommands(
  text: string,
  start: number,
  closer: ')' | '`' | undefined,
  parsed: Parsed,
  depth: number,
  mode: ShellMode,
): number {
  if (depth > MAX_DEPTH) throw new Error('Shell nesting too deep');
  const out = parsed.segments;

  let segment: Word[] = [];
  let word: Word | undefined;
  // What the next finished word is, other than an argument.
  let redirect: 'none' | 'target' | 'heredoc' = 'none';
  let stripTabs = false;
  let heredocs: Heredoc[] = [];
  let openParens = 0;
  // Whether the current segment reads input, and whether `(` opens a
  // process substitution, whose commands read or write a pipe.
  let fed = false;
  let redirected = false;
  let procSub = false;
  // The operator of an output redirection whose target word comes next.
  let output: string | undefined;

  const current = (): Word => (word ??= {text: '', dynamic: false, start: i});

  function endWord(): void {
    if (!word) return;

    // A case pattern's closing parenthesis can confuse substitution bounds.
    if (
      word.text === 'case' &&
      !word.dynamic &&
      segment.length === 0 &&
      (depth > 0 || openParens > 0)
    ) {
      mode.uncertain = true;
    }
    if (output !== undefined && !isHarmlessOutput(output, word))
      parsed.writesOutput = true;
    output = undefined;
    word.raw = text.slice(word.start, i);
    if (redirect === 'heredoc')
      heredocs.push({delimiter: word.text, stripTabs});
    else if (redirect === 'none') segment.push(word);

    redirect = 'none';
    word = undefined;
  }

  function endSegment(pipeAfter = false): void {
    endWord();
    // A redirection with no target: fail closed.
    if (output !== undefined) parsed.writesOutput = true;
    output = undefined;
    redirect = 'none';
    if (segment.length > 0) {
      if (fed) parsed.fed.add(segment);
      if (redirected) parsed.redirected.add(segment);
      out.push(segment);
      fed = false;
    }
    redirected = false;
    fed ||= pipeAfter;
    segment = [];
  }

  function substitution(from: number, end: ')' | '`'): number {
    current().dynamic = current().expands = true;
    return scanCommands(text, from, end, parsed, depth + 1, mode);
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
        current().dynamic = current().expands = true;
        mode.uncertain = true;
      }
      i = close < 0 ? text.length : close + 1;
    } else if (char === '"') {
      i = scanDoubleQuoted(
        text,
        i + 1,
        current(),
        (from, end) => scanCommands(text, from, end, parsed, depth + 1, mode),
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
      // A continuation can split a process substitution; extglobs also make
      // the outer argument boundaries uncertain.
      const afterWord = word || segment.length > 0 || redirect !== 'none';
      if (!mode.legacy && afterWord) mode.uncertain = true;
      endSegment(procSub);
      procSub = false;
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
      redirected = true;

      if (!mode.legacy) {
        if (!KNOWN_OPERATORS.has(operator)) mode.uncertain = true;

        // `>(...)` and `<(...)` hand the outer command a pipe, after whatever
        // redirect operator comes before it (`2>>(...)`, `>&>(...)`). The body
        // is a segment of its own; the pipe is a file name the outer command's
        // arguments never depend on, so it is left out and the outer command
        // carries on after it as if it were not there.
        if (/[<>]$/u.test(operator) && text[i] === '(') {
          mode.uncertain = true;
          fed = true;
          if (operator.includes('>')) parsed.writesOutput = true;
          i = scanCommands(text, i + 1, ')', parsed, depth + 1, mode);
          redirect = 'none';
          continue;
        }
      }

      const isHeredoc = operator === '<<';
      stripTabs = isHeredoc && text[i] === '-';
      if (stripTabs) i++;
      redirect = isHeredoc ? 'heredoc' : 'target';
      fed ||= operator.includes('<');
      procSub = text[i] === '(';
      if (procSub) fed = true;
      const writes = operator.includes('>');
      if (writes && procSub) parsed.writesOutput = true;
      else if (writes) output = operator;
    } else if (char === '|' && next === '|') {
      endSegment();
      i += 2;
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      endSegment(char === '|');
      i++;
      if (char === '\n' && heredocs.length > 0) {
        // An unterminated body is parsed as commands, which only adds lines.
        i = mode.legacy
          ? skipLegacyHeredocs(text, i, heredocs)
          : (skipHeredocs(text, i, heredocs) ?? i);
        heredocs = [];
      }
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
      i++;
    } else if (char === '#' && !word) {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline;
    } else {
      if ('$*?['.includes(char)) current().dynamic = current().expands = true;
      else if (char === '{') current().dynamic = true;
      current().text += char;
      i++;
    }
  }

  endSegment();
  // The text ended inside a substitution.
  if (closer) mode.uncertain = true;
  return text.length;
}
