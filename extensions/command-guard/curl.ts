import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// EL-115 PR6 curl download atom (Sophie's CR5/CR6 rulings): `curl -o <file>
// <url>` may skip its prompt only when the file is a plain repo-relative path
// that is not instructions, build input or config, the URL is public http(s),
// and no curlrc can redirect the output. Anything else keeps main's verdict.

const CURL_WORD =
  /^(?:-[sSLf]+|--(?:silent|show-error|location|fail|fail-with-body|compressed))$/u;
const CURL_VALUE = /^(?:--retry|--max-time|-m|--connect-timeout)$/u;
// Options that choose where curl writes, in any spelling the parser decodes.
const CURL_OUTPUT =
  /^-[a-zA-Z]*[oO]|^--(?:output|remote-name|remote-name-all|output-dir|create-dirs)(?![\w-])/u;

// True when curl may write a file: an output option other than /dev/null.
export function curlWrites(args: string[]): boolean {
  return args.some(
    (arg, i) =>
      CURL_OUTPUT.test(arg) &&
      !(/^-[a-zA-Z]*o$|^--output$/u.test(arg) && args[i + 1] === '/dev/null') &&
      arg !== '--output=/dev/null',
  );
}

const PROTECTED_DIRS = new Set([
  'src',
  'scripts',
  'node_modules',
  'extensions',
]);
const PROTECTED_NAME =
  /agent|claude|gemini|copilot|cursor|guard|^(?:makefile|gnumakefile|justfile|dockerfile|package\.json)$|lock|^tsconfig|\.config\.|\.(?:toml|ya?ml|ini|cfg|conf|rc)$/iu;

export function isRepoOutput(path: string): boolean {
  if (!/^[\w+=,%][\w.+=,%/-]*$/u.test(path.replace(/^\.\//u, ''))) return false;
  const parts = path.replace(/^\.\//u, '').split('/');
  const name = parts[parts.length - 1];
  if (parts.some(part => part === '' || part.startsWith('.'))) return false;
  if (parts.length === 1 && /\.md$/iu.test(name)) return false;
  if (PROTECTED_DIRS.has(parts[0])) return false;
  return !PROTECTED_NAME.test(name);
}

// A public http(s) URL: no credentials, no IP literal outside public IPv4,
// no single-label, localhost, .local or bracketed (IPv6) host.
export function isPublicUrl(url: string): boolean {
  const match =
    /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#][\w.~:/?#%=+,&-]*)?$/iu.exec(
      url,
    );
  if (!match) return false;
  const host = match[1].toLowerCase().replace(/\.$/u, '');
  if (
    !host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/u.test(host)
  )
    return false;
  if (!/^[\d.]+$|^0x|\.0x/u.test(host))
    return /[a-z]/u.test(host.split('.').pop()!);
  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    !/^(?:(?:[1-9]\d{0,2}|0)\.){3}(?:[1-9]\d{0,2}|0)$/u.test(host) ||
    octets.some(n => n > 255)
  )
    return false;
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// `curl [quiet flags] -o <repo file> <public url>...`, every word literal.
export function isCurlDownload(args: string[]): boolean {
  let output = false;
  let url = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (CURL_WORD.test(arg)) continue;
    if (isPublicUrl(arg)) url = true;
    else if (CURL_VALUE.test(arg) && /^\d+$/u.test(args[i + 1] ?? '')) i++;
    else if (
      /^-[sSLf]*o$|^--output$/u.test(arg) &&
      isRepoOutput(args[i + 1] ?? '')
    ) {
      output = true;
      i++;
    } else if (/^--output=/u.test(arg) && isRepoOutput(arg.slice(9)))
      output = true;
    else return false;
  }
  return output && url;
}

// --- curlrc (checked where the guard runs) -------------------------------
// An option line naming output, remote-name, output-dir or create-dirs, with
// or without dashes, or a short -o/-O bundle.
const RISKY_RC =
  /^[ \t]*(?:-[a-zA-Z]*[oO]|-{0,2}(?:output-dir|create-dirs|output|remote-name(?:-all)?))(?![\w-])/mu;

export function curlrcPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const paths = [
    join(xdg, '.curlrc'),
    join(xdg, 'curlrc'),
    join(home, '.curlrc'),
  ];
  if (env.CURL_HOME)
    paths.unshift(
      join(env.CURL_HOME, '.curlrc'),
      join(env.CURL_HOME, '.config', 'curlrc'),
    );
  return paths;
}

const cache = new Map<string, {stamp: string; risky: boolean}>();

// True when a curlrc might redirect output; unreadable counts as risky.
function riskyFile(path: string): boolean {
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
      (error as NodeJS.ErrnoException).code !== 'ENOTDIR'
    );
  }
  const hit = cache.get(path);
  if (hit?.stamp === stamp) return hit.risky;
  let risky: boolean;
  try {
    risky = RISKY_RC.test(readFileSync(path, 'utf8'));
  } catch {
    risky = true;
  }
  cache.set(path, {stamp, risky});
  return risky;
}

export const curlrcRiskyIn = (env: NodeJS.ProcessEnv): boolean =>
  curlrcPaths(env).some(riskyFile);

export type CurlrcCheck = () => boolean;
const defaultCheck: CurlrcCheck = () => curlrcRiskyIn(process.env);
let check = defaultCheck;

// Tests swap the check; nothing reads the real home directory there.
export function setCurlrcCheck(next?: CurlrcCheck): void {
  check = next ?? defaultCheck;
}

export const curlrcRisky = (): boolean => check();
