import {basename} from 'node:path';
import type {Decision} from './commands.ts';
import {parseSegments, type Word} from './shell.ts';

// Finds the literal scripts of `sh -c script` and `eval script`, which are
// commands too. Script files and custom tools are never read.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const SHELL_VALUE_OPTIONS = new Set(['--rcfile', '--init-file']);
const MAX_SCRIPT_DEPTH = 3;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// Options of the supported wrappers that leave the wrapped command in place.
const WRAPPER_FLAGS: Record<string, Set<string>> = {
  env: new Set(['-', '-i', '-v', '--ignore-environment']),
  time: new Set(['-p', '-l']),
};
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset']);

const SCRIPT_UNRESOLVED: Decision = {
  verdict: 'deny',
  reason:
    'shell command string contains an expansion, so the command guard cannot inspect what it would run',
  advice:
    'Put the script in single quotes, or run the command directly without a shell wrapper.',
};
const WRAPPER_UNRESOLVED: Decision = {
  verdict: 'deny',
  reason:
    'env or time option the command guard does not analyze comes before a shell command string',
  advice: 'Run the command directly, without the wrapper.',
};
const SCRIPT_TOO_DEEP: Decision = {
  verdict: 'deny',
  reason:
    'command strings are nested more deeply than the command guard inspects',
};
const EVAL_UNRESOLVED: Decision = {
  verdict: 'ask',
  reason: 'eval of a computed command, which the command guard cannot inspect',
};

function runsScripts(word: Word): boolean {
  return (
    !word.dynamic && (word.text === 'eval' || SHELLS.has(basename(word.text)))
  );
}

// A dynamic word may expand to an option; an assignment's value may not.
function isWrapperOption(word: Word): boolean {
  if (ASSIGNMENT.test(word.text)) return false;
  return word.dynamic || word.text.startsWith('-');
}

// The command after leading assignments and `env` or `time`. `resolved` is
// false when a wrapper option is unknown, so where the command starts is too.
function unwrap(segment: Word[]): {command: Word[]; resolved: boolean} {
  let resolved = true;
  let i = 0;

  while (i < segment.length) {
    const wrapper = segment[i].dynamic ? '' : basename(segment[i].text);

    if (wrapper === 'env' || wrapper === 'time') {
      i++;
      while (i < segment.length && isWrapperOption(segment[i])) {
        const {text, dynamic} = segment[i];
        const takesValue = wrapper === 'env' && ENV_VALUE_OPTIONS.has(text);
        const known =
          takesValue ||
          WRAPPER_FLAGS[wrapper].has(text) ||
          text.startsWith('--unset=');

        if (dynamic || !known) resolved = false;
        i += takesValue ? 2 : 1;
      }
    } else if (ASSIGNMENT.test(segment[i].text)) i++;
    else break;
  }

  return {command: segment.slice(i), resolved};
}

// The script word of a shell invocation such as `bash -lc script`. Options
// are read the way the shell reads them: `c` may sit anywhere in a bundle,
// and the script is the first word that is not an option or its value.
function shellScript(args: Word[]): Word | undefined {
  let readsScript = false;

  for (let i = 0; i < args.length; i++) {
    const {text} = args[i];

    if (text === '--help' || text === '--version') return undefined;
    if (text === '--' || text === '-')
      return readsScript ? args[i + 1] : undefined;
    if (!/^[-+]./u.test(text)) return readsScript ? args[i] : undefined;

    if (text.startsWith('--')) {
      if (SHELL_VALUE_OPTIONS.has(text)) i++;
      continue;
    }

    if (text.startsWith('-') && text.includes('c')) readsScript = true;
    // `-o name` and Bash's `-O name` take the next word.
    if (/[oO]/u.test(text)) i++;
  }

  return undefined;
}

function nestedScript(segment: Word[]): {script?: string; decision?: Decision} {
  const {command, resolved} = unwrap(segment);
  if (!resolved)
    return command.some(runsScripts) ? {decision: WRAPPER_UNRESOLVED} : {};

  const [runner, ...args] = command;
  if (!runner || !runsScripts(runner)) return {};

  if (runner.text === 'eval') {
    if (args.length === 0) return {};
    const decision = args.some(arg => arg.dynamic)
      ? EVAL_UNRESOLVED
      : undefined;
    return {script: args.map(arg => arg.text).join(' '), decision};
  }

  const script = shellScript(args);
  if (!script) return {};
  // The outer shell expands the word before the inner shell parses it, so
  // even a variable in argument position can add commands. The literal part
  // is still inspected, for the rules that match text.
  return {
    script: script.text,
    decision: script.dynamic ? SCRIPT_UNRESOLVED : undefined,
  };
}

// `segments` followed by the commands of every literal script among them,
// with a decision for each script that cannot be inspected.
export function expandScripts(segments: Word[][]): {
  segments: Word[][];
  decisions: Decision[];
} {
  const decisions: Decision[] = [];

  function expand(list: Word[][], depth: number): Word[][] {
    return list.flatMap(segment => {
      const {script, decision} = nestedScript(segment);
      if (decision) decisions.push(decision);
      if (script === undefined) return [segment];

      if (depth >= MAX_SCRIPT_DEPTH) {
        decisions.push(SCRIPT_TOO_DEEP);
        return [segment];
      }
      return [segment, ...expand(parseSegments(script), depth + 1)];
    });
  }

  return {segments: expand(segments, 0), decisions};
}
