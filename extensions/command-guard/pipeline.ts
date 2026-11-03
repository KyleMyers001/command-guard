// Pipe-to-shell: `curl url | sh`. The parsed segments drop pipes, so this
// reads text. Quoted text is data, not shell syntax, so it is removed first:
// `git commit -m "never run curl url | sh"` is not a pipeline.

const TO_SHELL =
  /(^|[;&|(`\s])(curl|wget)[\s][^;&|]*\|[\s]*(sudo[\s]+)?(\/(usr\/)?(local\/)?bin\/)?(ba|z|da)?sh([\s;&|)}<>`]|$)/u;

// The text with the inside of every quoted string removed. A backslash
// escapes the next character, except inside single quotes.
function withoutQuoted(text: string): string {
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
      result += char + (text[++i] ?? '');
    } else {
      if (char === "'" || char === '"') quote = char;
      result += char;
    }
  }

  return result;
}

export function pipesToShell(text: string): boolean {
  return TO_SHELL.test(withoutQuoted(text));
}
