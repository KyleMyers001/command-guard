// Commands that run a denied command spelled with quotes, backslashes or a
// line continuation, in the places a shell reads a command or a script.

export interface Case {
  name: string;
  command: string;
  // The command's own words are computed at run time, so only a run shows them.
  dynamic?: boolean;
}

// Spellings of each target. `'` and `"` are marked so a spelling is only put
// inside a string whose own quote it does not hold.
const spellings: Record<string, string[]> = {
  'pnpm -r publish': [
    "pn''pm -r pub''lish",
    'pn""pm -r pub""lish',
    'p\\npm -r pub\\lish',
    "'pnpm' -r 'publish'",
    '"pnpm" -r "publish"',
    "pnpm -r p'u'b'l'i'sh'",
    'pn\'\'pm -r "pub"lish',
    '\\p\\n\\p\\m -r \\p\\u\\b\\l\\i\\s\\h',
    'pnpm -r pub\\\nlish',
    "pnpm -r pub''''''lish",
    'pnpm -r \'pu\'b"li"sh',
  ],
  'git push --force': [
    "git pu''sh --force",
    'git pu""sh --force',
    'git pu\\sh --force',
    "'git' 'push' '--force'",
    'g\\it pus\\h --for\\ce',
    "git push --for''ce",
    'g\'\'i""t pu\\sh --force',
  ],
  'rm -rf /': ["r''m -rf /", 'rm -r\\f /', '"rm" "-rf" "/"', "rm -'rf' /"],
};

const bare = (inner: string) => [
  `sudo ${inner}`,
  `sudo -u root ${inner}`,
  `env FOO=1 ${inner}`,
  `command ${inner}`,
  `time ${inner}`,
  `nohup ${inner}`,
  `if true; then ${inner}; fi`,
  `if ${inner}; then :; fi`,
  `{ ${inner}; }`,
  `! ${inner}`,
  `f() { ${inner}; }; f`,
  `function f { ${inner}; }; f`,
  `while ${inner}; do :; done`,
  `while true; do ${inner}; done`,
  `until ${inner}; do :; done`,
  `sh <<EOF\n${inner}\nEOF`,
];

const quoted = (inner: string, q: string) => [
  `sudo bash -c ${q}${inner}${q}`,
  `nohup sh -c ${q}${inner}${q}`,
  `timeout 5 sh -c ${q}${inner}${q}`,
  `nohup timeout 9 bash -c ${q}${inner}${q}`,
  `find . -exec sh -c ${q}${inner}${q} \\;`,
  `find . -exec bash -c ${q}${inner}${q} _ {} +`,
  `echo x | xargs bash -c ${q}${inner}${q}`,
  `xargs -I{} sh -c ${q}${inner}${q}`,
  `bash <<<${q}${inner}${q}`,
  `echo ${q}${inner}${q} | sh`,
  `echo ${q}${inner}${q} | sudo bash`,
  `eval ${q}${inner}${q}`,
  `sudo sh -c ${q}if true; then ${inner}; fi${q}`,
  `sh -c ${q}f() { ${inner}; }; f${q}`,
];

// The forms with a word computed at run time, as nothing but a run reads them.
const computed = [
  'sudo bash -c "pnpm -r $ACT"',
  'bash -c "p$X -r publish"',
  'eval "pnpm -r pub${E}lish"',
  "pnpm -r $'pub\\x6cish'",
  'sudo sh -c "pnpm -r pub`echo`lish"',
  'echo "pnpm -r $(echo publish)" | sh',
];

export function obfuscationCases(): Case[] {
  const cases: Case[] = [];
  for (const [target, forms] of Object.entries(spellings)) {
    for (const form of forms) {
      const add = (command: string) =>
        cases.push({name: `${command}`, command});
      for (const command of bare(form)) add(command);
      if (!form.includes("'")) quoted(form, "'").forEach(add);
      if (!form.includes('"')) quoted(form, '"').forEach(add);
      void target;
    }
  }
  for (const command of computed)
    cases.push({name: command, command, dynamic: true});
  return cases;
}

export const padding = (words: number) => 'x '.repeat(words).trim();
