export interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

// Every line of the text, indexed once by its content (exact and with
// leading tabs stripped), so finding a closing delimiter never rescans the
// text (CR F5: `a <<EOF` repeated was quadratic).
interface LineIndex {
  text: string;
  exact: Map<string, number[]>;
  stripped: Map<string, number[]>;
}
let index: LineIndex | undefined;

function linesOf(text: string): LineIndex {
  if (index?.text === text) return index;
  const exact = new Map<string, number[]>();
  const stripped = new Map<string, number[]>();
  const add = (map: Map<string, number[]>, key: string, end: number) => {
    const list = map.get(key);
    if (list) list.push(end);
    else map.set(key, [end]);
  };
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, newline < 0 ? end : newline);
    const plain = line.replace(/\r$/u, '');
    // Keyed by the line's start; the body resumes after `end`.
    add(exact, plain, start);
    add(stripped, plain.replace(/^\t+/u, ''), start);
    start = end;
  }
  index = {text, exact, stripped};
  return index;
}

// The first indexed line start at or after `from`, by binary search.
function firstFrom(list: number[] | undefined, from: number): number {
  if (!list) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid] < from) low = mid + 1;
    else high = mid;
  }
  return low < list.length ? list[low] : -1;
}

// Here-document bodies are data. Returns the index after the last body, or
// undefined when a body has no closing delimiter.
export function skipHeredocs(
  text: string,
  start: number,
  heredocs: Heredoc[],
): number | undefined {
  const lines = linesOf(text);
  let i = start;
  for (const {delimiter, stripTabs} of heredocs) {
    if (i >= text.length) return undefined;
    const at = firstFrom(
      (stripTabs ? lines.stripped : lines.exact).get(delimiter),
      i,
    );
    if (at < 0) return undefined;
    const newline = text.indexOf('\n', at);
    i = newline < 0 ? text.length : newline + 1;
  }
  return i;
}
