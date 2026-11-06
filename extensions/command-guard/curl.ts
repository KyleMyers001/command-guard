// The predicates behind the `curl -o` download exemption (exemptions.ts):
// the file must be a plain repo-relative data file that is not instructions,
// build input or config, and the URL public http(s).

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

// A literal relative file at the repo root or up to three levels under an
// output directory, with a data or archive extension, and not a known
// config, manifest, lock or agent file.
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
const ROOT_NAME =
  /^(?:out|output|download|downloads|data|result|results|response)(?:[._-][A-Za-z0-9._-]*)?$/u;
// Any name holding one of these, anywhere and in any case, may be config,
// policy, credentials or build input.
const SENSITIVE =
  /config|conf|lock|polic|setting|mcp|guard|agent|claude|cursor|rule|secret|cred|token|key|env|manifest|package|shrinkwrap|extension/iu;
const MANIFEST =
  /^(?:package|composer|deno|turbo|nx|vercel|renovate|lerna)\.json$|^tsconfig|\.config\.|rc\.json$|(?:^|[^a-z0-9])lock(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])(?:agents?|claude|gemini|copilot|cursor|codex|command-guard)(?:[^a-z0-9]|$)/iu;

export function isRepoOutput(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1];
  if (!parts.every(part => PART.test(part))) return false;
  if (parts.length > 1 && (!OUT_DIRS.has(parts[0]) || parts.length > 4))
    return false;
  if (!DATA.test(name) || MANIFEST.test(name)) return false;
  // At the repo root only output-style names are allowed.
  if (parts.length === 1)
    return ROOT_NAME.test(name.replace(DATA, '')) && !SENSITIVE.test(name);
  return !parts.slice(1).some(part => SENSITIVE.test(part));
}

// A valid DNS name over http(s) whose last label is on a public-TLD
// allowlist. IP literals, single labels, labels
// that embed an IPv4 address, wildcard-loopback and rebinding domains,
// credentials and anything malformed keep main's verdict. Redirects (-L)
// and DNS rebinding cannot be resolved statically.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PUBLIC_TLD = new Set(
  'com org net io dev app ai co gov edu us uk de fr ca eu jp sh me'.split(' '),
);
const BLOCKED =
  /(?:^|\.)(?:1u\.ms|rbndr\.us|rebind\.network|rebinder\.net|nip\.direct|nip\.name|xip\.name|xip\.io|nip\.io|sslip\.io|vcap\.me|localdev\.me|lvh\.me|local\.gd|localtest\.me|lacolhost\.com|traefik\.me|fuf\.me|fbi\.com|ngrok\.io|ngrok\.app|ngrok-free\.app|ngrok\.dev|ngrok\.pro|ngrok-free\.dev|ngrok\.pizza|ngrok\.me|0cf\.io|nip\.sh|sslip\.me)$/u;
// An all-digit label or a leading zero (octal `0177`, hex `0x7f`) may be an
// address.
const NUMERIC = /(?:^|\.)(?:\d+|0[a-z0-9-]*)(?:\.|$)/u;
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
    PUBLIC_TLD.has(labels[labels.length - 1]) &&
    !BLOCKED.test(host) &&
    !NUMERIC.test(host) &&
    !EMBEDDED_V4.test(host)
  );
}
