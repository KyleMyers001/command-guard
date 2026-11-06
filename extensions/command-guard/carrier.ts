// EL-115 PR6: commands that run another command line out of sight.
import {normalize, SHELLS} from './chain.ts';

// Ruling 1 for remote and container shells: the command they carry is
// opaque, so a chain that mentions a class keeps main's verdict.
const CARRIER = /^(?:ssh|su|nsenter|chroot)$/u;
export const carriesCommand = (words: string[]): boolean => {
  const [head = ''] = normalize(words);
  return (
    CARRIER.test(head) ||
    SHELLS.has(head) ||
    (/^(?:docker|podman|kubectl)$/u.test(head) && words.includes('exec'))
  );
};
// Heredoc bodies and quoted remote commands are not in the canonical text,
// so the marker line names the class words seen anywhere in the command.
export function carriedClasses(command: string): string {
  const found = command.match(
    /(?<![\w.-])(?:rm|merge|config|graphql|curl)(?![\w-])|--detach|migrat/gu,
  );
  const output = /[\s'"](?:-[a-zA-Z]*o|--output)(?![\w-])/u.test(command);
  return ['__carried__', ...new Set(found), ...(output ? ['-o'] : [])].join(
    ' ',
  );
}
