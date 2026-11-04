import {basename} from 'node:path';
import type {Word} from './shell.ts';

// Long options that send a file, stdin or local data. curl accepts any
// unambiguous prefix, so a prefix of three or more characters counts.
const SENDS = [
  'upload-file',
  'data',
  'data-ascii',
  'data-binary',
  'data-raw',
  'data-urlencode',
  'form',
  'form-string',
  'json',
  'config',
  'url-query',
  'variable',
  'cookie',
  'header',
  'proxy-header',
];
// Short options that send data or read a config: -T -d -F -K -b -H.
const SHORT_SENDS = /^-[a-zA-Z]*[TdFKbH]/u;

function sends(word: Word, afterOption: boolean): boolean {
  const {text} = word;
  if (afterOption && (word.dynamic || /[@<]/u.test(text))) return true;
  if (!text.startsWith('-') || text === '-' || text === '--') return false;
  if (word.dynamic || /[@<]/u.test(text)) return true;
  if (text.startsWith('--')) {
    // `--expand-` (curl 8.3+) keeps the option's meaning.
    const name = text
      .slice(2)
      .split('=')[0]
      .replace(/^expand-/u, '');
    return name.length >= 3 && SENDS.some(option => option.startsWith(name));
  }
  return SHORT_SENDS.test(text);
}

// Coarse and fail-closed: a curl command, behind any wrapper, that may send
// local data. Option values that are dynamic or name a file with `@`/`<`
// count, as does any option spelled like a sending one.
// Only chains that also run something else get the flag: the exfil rules
// exempt chains made only of these tools, and an extra line would end that.
const TOOLS_ONLY = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'env',
  'printenv',
  'set',
  'export',
  'declare',
  'compgen',
]);

export function curlMaySend(segments: Word[][]): boolean {
  const mixed = segments.some(segment => {
    const head = segment.find(
      word =>
        !['env', 'command'].includes(word.text) &&
        !/^[A-Za-z_]\w*=/u.test(word.text),
    );
    return head !== undefined && !TOOLS_ONLY.has(basename(head.text));
  });
  return (
    mixed &&
    segments.some(segment => {
      const at = segment.findIndex(
        word => !word.dynamic && basename(word.text) === 'curl',
      );
      if (at < 0) return false;
      const args = segment.slice(at + 1);
      return args.some((word, i) =>
        sends(word, i > 0 && /^-[^=]*$/u.test(args[i - 1].text)),
      );
    })
  );
}
