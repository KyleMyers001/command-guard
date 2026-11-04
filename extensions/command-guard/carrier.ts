// EL-115 PR6: commands that run another command line out of sight.
import {normalize, SHELLS} from './chain.ts';

// Ruling 1 for remote and container shells: the command they carry is
// opaque, so a chain that mentions a class keeps main's verdict.
const CARRIER = /^(?:ssh|su|nsenter|chroot)$/u;
const CLASS_TEXT = /\brm\b|merge|config|graphql|--detach|migrat|curl/u;
export const carriesCommand = (words: string[]): boolean => {
  const [head = ''] = normalize(words);
  return (
    CARRIER.test(head) ||
    SHELLS.has(head) ||
    (/^(?:docker|podman|kubectl)$/u.test(head) && words.includes('exec'))
  );
};
export const carrierWithClass = (command: string, lists: string[][]) =>
  CLASS_TEXT.test(command) && lists.some(carriesCommand);
// A heredoc body is not in the canonical text, so name the carried classes.
export function carriedClasses(command: string, lists: string[][]): string {
  if (!carrierWithClass(command, lists)) return '';
  const found = command.match(
    /(?<![\w.-])(?:rm|merge|config|graphql|curl)(?![\w-])|--detach|migrat/gu,
  );
  const output = /[\s'"](?:-[a-zA-Z]*o|--output)(?![\w-])/u.test(command);
  return ['__carried__', ...new Set(found), ...(output ? ['-o'] : [])].join(
    ' ',
  );
}
