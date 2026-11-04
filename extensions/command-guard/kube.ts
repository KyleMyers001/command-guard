import type {Decision} from './commands.ts';
import type {Word} from './shell.ts';

const KUBECTL_DRY_RUNS = new Set(['--dry-run=client', '--dry-run=server']);
const KUBECTL_MUTATIONS = new Set([
  'delete',
  'apply',
  'replace',
  'patch',
  'scale',
  'drain',
  'cordon',
]);
const KUBECTL_ROLLOUT_MUTATIONS = new Set(['restart', 'undo']);
const HELM_MUTATIONS = new Set([
  'delete',
  'uninstall',
  'install',
  'upgrade',
  'rollback',
]);

const KUBECTL_MUTATES: Decision = {
  verdict: 'ask',
  reason:
    'kubectl command changes cluster state; only a single --dry-run=client or --dry-run=server is exempt',
};
const HELM_MUTATES: Decision = {
  verdict: 'ask',
  reason:
    'helm command changes a release; dry-run flags are not trusted because their meaning varies by Helm version',
};

export function classifyKubectl(args: Word[]): Decision[] {
  const mutates = args.some(
    (arg, i) =>
      KUBECTL_MUTATIONS.has(arg.text) ||
      (arg.text === 'rollout' &&
        KUBECTL_ROLLOUT_MUTATIONS.has(args[i + 1]?.text)),
  );
  if (!mutates) return [];

  // `--dry-run=none` runs for real, and a repeated flag is ambiguous.
  const dryRuns = args.filter(arg => arg.text.startsWith('--dry-run'));
  const isDryRun =
    dryRuns.length === 1 &&
    !dryRuns[0].dynamic &&
    KUBECTL_DRY_RUNS.has(dryRuns[0].text);
  return isDryRun ? [] : [KUBECTL_MUTATES];
}

export function classifyHelm(args: Word[]): Decision[] {
  return args.some(arg => HELM_MUTATIONS.has(arg.text)) ? [HELM_MUTATES] : [];
}
