import type {Word} from './shell.ts';

// `gh` accepts its repository option anywhere, including before the command.
export function withoutGhRepo(args: Word[]): Word[] {
  const rest: Word[] = [];

  for (let i = 0; i < args.length; i++) {
    const {text} = args[i];
    if (text === '-R' || text === '--repo') i++;
    else if (!/^(-R.|--repo=)/u.test(text)) rest.push(args[i]);
  }

  return rest;
}

const GH_API_VALUE_OPTIONS = new Set([
  '--method',
  '--field',
  '--raw-field',
  '--header',
  '--jq',
  '--template',
  '--input',
  '--preview',
  '--hostname',
  '--cache',
]);

// `gh api -XPUT -ftitle=x` respelled `-X PUT -f title=x`, the spelling text
// rules are written for. Only whole option words change: values of other
// options, the endpoint, and words after `--` stay as written.
export function withSeparateApiValues(args: Word[]): Word[] {
  if (args[0]?.text !== 'api') return args;
  const rest: Word[] = [];

  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word.text === '--') return [...rest, ...args.slice(i)];

    // `-i` is the only short flag without a value, so it may lead a bundle.
    const short = /^-(i*)([XfFHqtp])=?(.*)$/u.exec(word.text);
    if (short?.[3]) {
      for (let j = 0; j < short[1].length; j++) {
        rest.push({text: '-i', dynamic: false});
      }
      rest.push({text: `-${short[2]}`, dynamic: false});
      rest.push({text: short[3], dynamic: word.dynamic});
      continue;
    }

    rest.push(word);
    const valueFollows = short !== null || GH_API_VALUE_OPTIONS.has(word.text);
    if (valueFollows && i + 1 < args.length) rest.push(args[++i]);
  }

  return rest;
}

// `gh` as a rule names it: the repository option and `api` value spellings
// normalised.
export function ghArgs(args: Word[]): Word[] {
  return withSeparateApiValues(withoutGhRepo(args));
}
