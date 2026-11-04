export interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

// Here-document bodies are data. Returns the index after the last body, or
// undefined when a body has no closing delimiter.
export function skipHeredocs(
  text: string,
  start: number,
  heredocs: Heredoc[],
): number | undefined {
  let i = start;

  for (const {delimiter, stripTabs} of heredocs) {
    for (;;) {
      if (i >= text.length) return undefined;
      const newline = text.indexOf('\n', i);
      const end = newline < 0 ? text.length : newline;
      const line = text.slice(i, end).replace(/\r$/u, '');
      i = newline < 0 ? text.length : newline + 1;

      if ((stripTabs ? line.replace(/^\t+/u, '') : line) === delimiter) break;
    }
  }

  return i;
}
