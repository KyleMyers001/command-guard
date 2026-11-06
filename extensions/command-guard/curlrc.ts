import {readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// curl reads a default config file unless -q is given, and any option there
// applies to `curl -o`. The download exemption stays on only when every
// curlrc option is on this allowlist, spelled in full or as its short flag.
// Anything else, including abbreviations, `config`/`-K` includes and read
// errors, turns it off (fail closed).
const LONG = new Set([
  'silent',
  'show-error',
  'location',
  'fail',
  'retry',
  'retry-delay',
  'connect-timeout',
  'max-time',
  'user-agent',
  'compressed',
]);
const SHORT_FLAGS = /^-[sSLf]+$/u;
const SHORT_VALUE = /^-[Am]$/u;

function safeLine(line: string): boolean {
  const text = line.trim();
  if (text === '' || text.startsWith('#')) return true;
  const [option] = text.split(/[\s=:]/u, 1);
  if (SHORT_FLAGS.test(option) || SHORT_VALUE.test(option)) return true;
  return LONG.has(option.replace(/^--/u, ''));
}

export function curlrcPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? homedir();
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const paths = [
    join(xdg, '.curlrc'),
    join(xdg, 'curlrc'),
    join(home, '.config', 'curlrc'),
    join(home, '.config', '.curlrc'),
    join(home, '.curlrc'),
  ];
  if (env.CURL_HOME)
    paths.unshift(
      join(env.CURL_HOME, '.curlrc'),
      join(env.CURL_HOME, '.config', 'curlrc'),
    );
  return [...new Set(paths)];
}

const cache = new Map<string, {stamp: string; risky: boolean}>();

// True unless the file is absent or holds only allowlisted options.
function riskyFile(path: string): boolean {
  let stamp: string;
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    const {code} = error as NodeJS.ErrnoException;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
  const hit = cache.get(path);
  if (hit?.stamp === stamp) return hit.risky;
  let risky: boolean;
  try {
    risky = !readFileSync(path, 'utf8').split(/\r?\n/u).every(safeLine);
  } catch {
    risky = true;
  }
  cache.set(path, {stamp, risky});
  return risky;
}

export const curlrcRiskyIn = (env: NodeJS.ProcessEnv): boolean =>
  curlrcPaths(env).some(riskyFile);
