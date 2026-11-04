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

// CR F2 (allowlist): a literal relative file at the repo root or up to
// three levels under an output directory, with a data or archive extension,
// and not a known config, manifest, lock or agent file.
const OUT_DIRS = new Set([
  'dist',
  'build',
  'out',
  'tmp',
  'artifacts',
  'downloads',
]);
const PART = /^[A-Za-z0-9_][\w+=,%-]*(?:\.[\w+=,%-]+)*$/u;
const DATA = /\.(?:json|txt|csv|log|tar|gz|tgz|zip|png|jpe?g|gif|svg|pdf)$/iu;
const MANIFEST =
  /^(?:package|composer|deno|turbo|nx|vercel|renovate|lerna)\.json$|^tsconfig|\.config\.|rc\.json$|(?:^|[^a-z0-9])lock(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])(?:agents?|claude|gemini|copilot|cursor|codex|command-guard)(?:[^a-z0-9]|$)/iu;

export function isRepoOutput(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (!parts.every(part => PART.test(part))) return false;
  if (parts.length > 1 && (!OUT_DIRS.has(parts[0]) || parts.length > 4))
    return false;
  return DATA.test(name) && !MANIFEST.test(name);
}

// CR F3: a syntactically valid public DNS name over http(s). IP literals,
// labels that embed an IPv4 address, wildcard-DNS suffixes, local names,
// credentials and ports-only hosts keep main's verdict. Redirects (-L) and
// DNS rebinding cannot be resolved statically.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const WILDCARD =
  /(?:^|\.)(?:nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|traefik\.me|localhost|local|internal|localdomain|home\.arpa)$/u;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const EMBEDDED_V4 = new RegExp(
  `(?:^|[.-])${OCTET}(?:[.-]${OCTET}){3}(?:[.-]|$)|(?:^|[.-])[0-9a-f]{8}(?:[.-]|$)`,
  'u',
);

export function isPublicUrl(url: string): boolean {
  const match =
    /^https?:\/\/([a-z0-9.-]+)(?::\d{1,5})?(?:[/?#][\w.~:/?#%=+,&-]*)?$/iu.exec(
      url,
    );
  if (!match) return false;
  const host = match[1].toLowerCase();
  const labels = host.split('.');
  return (
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every(label => LABEL.test(label)) &&
    /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/u.test(labels[labels.length - 1]) &&
    !WILDCARD.test(host) &&
    !EMBEDDED_V4.test(host)
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
