# Command Guard

Command Guard is a fail-closed [Pi](https://github.com/earendil-works/pi)
extension that inspects `bash`, `read`, `edit`, and `write` tool calls before Pi
executes them. It blocks forbidden operations, asks for one-time approval for
risky operations, and lets unmatched calls proceed.

This repository is the authoritative home of the extension, its two policy
assets, and its regression tests.

## Repository layout

- `extensions/command-guard.ts` — extension entrypoint and evaluation order
- `extensions/command-guard/` — policy, path, matching, shell, and command
  analysis helpers
- `command-guard.json` — editable Pi-specific deny/ask policy
- `dangerous-patterns.txt` — shared dangerous-command deny baseline
- `tests/` — unit, policy, relocation, and installed-Pi integration tests

The helper directory intentionally has no `index.ts`; Pi loads only the
entrypoint declared in `package.json`.

## Development

Requires Node 22.19 or newer.

```bash
npm ci
npm run check
```

`npm run check` runs strict TypeScript validation and the complete Node test
suite. Test command strings are parsed but never executed. Synthetic filesystem
fixtures are retained under `~/Workbench/Investigations/pi-extension-tests/`.

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

Run `/reload` after changing the checked-out code. Policy files are read on each
covered call, so valid policy changes apply immediately. A missing or invalid
policy fails closed; it never falls back to an older copy.

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
2. Shared regex matches deny Bash calls.
3. Command-analysis denies and JSON deny selectors block without an approval
   override.
4. Command-analysis asks and JSON ask selectors require approval for that exact
   invocation.
5. Otherwise the call proceeds.

Denial, cancellation, approval errors, invocation changes, and the 120-second
approval timeout all block the call. TUI and RPC modes use Pi's native
confirmation UI. JSON and print modes block asks because no approval UI is
available. No session-wide approvals are cached.

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
  the `u` flag.
- File selectors use `~/` for home, `//` for filesystem root, and relative paths
  for the current working directory. `*` stays within one segment; a complete
  `**` segment spans zero or more segments.

A single leading `/`, file-pattern `..`, character classes, `?`, braces,
parentheses, backslash escaping, partial `**` segments, unknown fields, and
unknown tools are rejected. File checks include Pi-style path normalization,
Unicode-equivalent spellings, read fallbacks, symlink targets, and existing
ancestors of new write targets.

To check a candidate policy before replacing the active file:

```bash
COMMAND_GUARD_POLICY=/path/to/candidate.json \
  node --test --test-name-pattern="policy examples" \
  tests/command-guard.test.mjs
```

Add or update a policy example whenever a rule changes. The examples pin allow,
ask, and deny behavior both with and without the shared baseline fixture.

## Command analysis

Some decisions depend on decoded arguments rather than text patterns. The guard
uses a bounded shell decoder; it is not a shell interpreter.

- `git push` requires an explicit remote and literal destination. Feature-branch
  pushes proceed, while protected destinations, force forms, deletion, bulk
  updates, implicit destinations, computed arguments, and unknown options deny.
- `git checkout` asks when it may overwrite files. Ordinary branch switching and
  branch creation remain allowed when the working directory can be established.
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

## Migrating a legacy symlink installation

Before changing a live installation:

1. Merge and verify the intended commit on `main`.
2. Clone that commit to a staging directory and run `npm ci && npm run check`.
3. Record the current extension symlink targets and relevant Pi settings.
4. Obtain explicit operator approval before removing or replacing symlinks.
5. Remove the explicit `+extensions/command-guard.ts` settings entry, if present.
6. Remove the legacy entrypoint symlink and replace the legacy helper-directory
   symlink with the verified runtime clone.
7. Remove obsolete Command Guard links under `~/.agents/hooks/`; Pi does not use
   them because both policy assets are repository-relative.
8. Run `/reload` in every active Pi session and validate with harmless synthetic
   allow, declined-ask, and deny inputs.

If loading or policy validation fails, use an external terminal to move the
runtime clone aside, restore the recorded extension symlinks, and restart or
reload Pi. The obsolete `~/.agents/hooks/` links do not need to be restored. Do
not submit a destructive command merely to test a deny.
