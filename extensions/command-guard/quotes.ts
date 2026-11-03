// Raw deny rules stop at an unquoted newline, because the guard's canonical
// text puts every command on its own line. A newline inside quotes belongs to
// one argument (`curl --data 'a<LF>b' url | sh`), so it is replaced by a space
// before those rules run. If a quote is misread (a comment, a heredoc body),
// the rule only sees more of the text, as it did before the newline stop.
export function neutralizeQuotedNewlines(text: string): string {
  if (!text.includes('\n') || !/['"]/u.test(text)) return text;

  let out = '';
  // '', "'", '"' or "$'" (the last takes backslash escapes).
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1] ?? '';

    if (quote === '') {
      if (char === '\\') {
        out += char + next;
        i++;
      } else if (char === '#' && (i === 0 || /[\s;&|(]/u.test(text[i - 1]))) {
        // A comment runs to the end of the line.
        const end = text.indexOf('\n', i);
        const stop = end < 0 ? text.length : end;
        out += text.slice(i, stop);
        i = stop - 1;
      } else {
        if (char === "'" || char === '"') {
          quote = char === "'" && text[i - 1] === '$' ? "$'" : char;
        }
        out += char;
      }
    } else if (char === '\\' && quote !== "'") {
      out += next === '\n' ? '\\ ' : char + next;
      i++;
    } else {
      if (char === quote.at(-1)) quote = '';
      out += char === '\n' ? ' ' : char;
    }
  }

  return out;
}
