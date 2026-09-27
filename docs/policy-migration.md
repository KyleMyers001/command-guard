# Historical rule coverage

Reviewed baseline: `53b5bdc74ec81d20a34020399fc796035911e2b3`.
All 36 active lines from the historical `dangerous-patterns.txt` are preserved,
in order, as the first 36 `permissions.deny` selectors. Each uses
`BashRawRegex((?m:...))`: raw **and canonical** spellings, no added flattened
spellings, and the same Unicode regex compiler as `BashRegex`. The previous
66 denies and 50 asks follow unchanged. Semantic overlap is intentionally kept.

`tests/fixtures/policy-migration-cases.json` records command inputs, expected
ALLOW/ASK/DENY, prompt counts, and historical line provenance—not regexes.
`tests/policy-migration.test.ts` checks all 879 rows against the real evaluator.
For each old line below, its `positive` and `neighbor` records plus 21 transformed
records pin both protection and matching boundaries. A neighbor can still ASK
or DENY because of another rule; the recorded verdict is the full combination.
Tests never read the retired asset. No legacy baseline is shipped or maintained
as a second pattern fixture.

| JSON deny position (1-based) | Historical line | Protection / positive input category  |
| ---------------------------- | --------------- | ------------------------------------- |
| 1                            | 8               | Root removal                          |
| 2                            | 9               | Root glob removal                     |
| 3                            | 10              | Home removal                          |
| 4                            | 11              | HOME variable glob removal            |
| 5                            | 12              | Users-directory removal               |
| 6                            | 13              | No-preserve-root option               |
| 7                            | 16              | Raw-disk `dd` output                  |
| 8                            | 17              | Raw-disk redirection                  |
| 9                            | 18              | Filesystem formatting                 |
| 10                           | 19              | Disk erasure                          |
| 11                           | 22              | Privileged removal                    |
| 12                           | 25              | Fork bomb                             |
| 13                           | 28              | Network content piped to a shell      |
| 14                           | 31              | Force push                            |
| 15                           | 32              | Force refspec                         |
| 16                           | 35              | Remote deletion option                |
| 17                           | 36              | Remote deletion refspec               |
| 18                           | 39              | Root permissions change               |
| 19                           | 40              | Root ownership change                 |
| 20                           | 43              | Immediate reflog expiry               |
| 21                           | 44              | Immediate pruning                     |
| 22                           | 47              | GitHub repository deletion            |
| 23                           | 48              | GitHub release deletion               |
| 24                           | 49              | GitHub secret deletion                |
| 25                           | 50              | GitHub API DELETE                     |
| 26                           | 51              | Public repository visibility          |
| 27                           | 52              | GitHub token access                   |
| 28                           | 57              | Bitwarden CLI access                  |
| 29                           | 58              | Password-store CLI access             |
| 30                           | 59              | 1Password CLI access                  |
| 31                           | 60              | Keychain access                       |
| 32                           | 61              | Password-manager application mentions |
| 33                           | 62              | Password-manager storage paths        |
| 34                           | 63              | Password-manager application launch   |
| 35                           | 64              | Password-manager package operations   |
| 36                           | 65              | Secret-key export                     |

Transforms: LF, CRLF, CR, U+2028, U+2029, tab, LF continuation, and CRLF
continuation (both prefix and space replacement); compound command, trailing
newline, quoted mention, supported nested shell, and split token. Additional
rows preserve the original probe plus canonicalization and collision examples.

The continuation collision is intentional compatibility, not a new relaxation:
`"printf fixture > /dev/disk9"` is DENY, while
`"printf fixture >\\\n/dev/disk9"` (JSON notation: backslash then LF) is ALLOW.
Flattening the latter would erase the distinction. Ordinary `BashRegex` and
`Bash` globs retain their existing flattened matching; only the new selector
omits it. Broad quoted mentions remain broad. Any future policy relaxation or
false-positive repair requires its own review.

Temporary full-evaluator differential evidence uses an external frozen old
checkout, never a runtime fallback. Sampled Unicode boundary agreement does
not establish universal equivalence between non-Unicode and Unicode regexes.
Deployment, external-consumer inventory, and whole-revision rollback gates are
in the README; mocked tests do not activate an installation or verify native UI.
