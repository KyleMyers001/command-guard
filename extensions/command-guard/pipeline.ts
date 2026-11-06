// Pipe-to-shell: `curl url | sh`. The parsed segments drop pipes, so this
// reads text. Only text the shell would execute counts: quoted strings,
// comments, escaped characters and here-document bodies are data, so
// `git commit -m "never run curl url | sh"` is not a pipeline.

const TO_SHELL =
  /(^|[;&|(`\s])(curl|wget)[\s][^;&|\n]*\|[\s]*(sudo[\s]+)?(\/(usr\/)?(local\/)?bin\/)?(ba|z|da)?sh([\s;&|)}<>`]|$)/u;
const HEREDOC = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>'"]+))/u;

interface Heredoc {
  word: string;
  stripTabs: boolean;
}

// Where the here-document bodies that start on the line before `start` end.
function afterBodies(text: string, start: number, pending: Heredoc[]): number {
  let at = start;

  for (const {word, stripTabs} of pending) {
    while (at < text.length) {
      const end = text.indexOf('\n', at);
      const line = text.slice(at, end < 0 ? text.length : end);
      at = end < 0 ? text.length : end + 1;
      if ((stripTabs ? line.replace(/^\t+/u, '') : line) === word) break;
    }
  }

  return at;
}

// The text with the inside of quotes, comments, escaped characters and
// here-document bodies removed.
function executableText(text: string): string {
  const pending: Heredoc[] = [];
  let result = '';
  let quote: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) {
        quote = undefined;
        result += char;
      }
    } else if (char === '\\') {
      // A continuation leaves its backslash, as the legacy rows pin; any
      // other escaped character cannot be a pipe or a separator.
      result += text[++i] === '\n' ? char : '_';
    } else if (char === '#' && (i === 0 || /[\s;&|(]/u.test(text[i - 1]))) {
      const end = text.indexOf('\n', i);
      i = (end < 0 ? text.length : end) - 1;
    } else if (char === '\n' && pending.length > 0) {
      result += char;
      i = afterBodies(text, i + 1, pending) - 1;
      pending.length = 0;
    } else if (char === '<' && text[i - 1] !== '<' && text[i + 2] !== '<') {
      const found = HEREDOC.exec(text.slice(i));
      if (!found) result += char;
      else {
        const word = found[2] ?? found[3] ?? found[4];
        pending.push({word, stripTabs: found[1] === '-'});
        result += ' ';
        i += found[0].length - 1;
      }
    } else {
      if (char === "'" || char === '"') quote = char;
      result += char;
    }
  }

  return result;
}

export function pipesToShell(text: string): boolean {
  // A match requires a literal pipe. Without one, repeated download words
  // make the regex retry the remaining suffix at each word (quadratic work).
  if (!text.includes('|')) return false;
  return TO_SHELL.test(executableText(text));
}
