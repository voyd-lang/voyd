# V-500 benchmark artifacts

These deterministic gzip archives contain the raw JSON measurements summarized
in `docs/notes/v-500-scoped-borrows-results.md`.

- Base revision: `b2a35155fca53d1e93e1465a3a4fde2a3f7bd2b0`
- Head revision: `6dfde641176b9ff0d0402e723f0cf732206944ca`
- Both measured worktrees were clean.
- Compression: `gzip -n -9`

The earlier single-sample callback and mutation smoke reports are intentionally
excluded because they measured dirty intermediate revisions.

| Raw JSON                                       | Raw bytes | Raw SHA-256                                                        | Gzip bytes | Gzip SHA-256                                                       |
| ---------------------------------------------- | --------: | ------------------------------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| `v500-ordinary-fields-base-head.json`          | 2,542,892 | `c4703a94d1510bae516563c2b51a52ca473052bc4a351f46cdccb8221bdd6de4` |    153,621 | `c17ceba2f1337fa3a8d96fca03ed9688c666e1e512d9fc9e98175ebc32b4fc79` |
| `v500-ordinary-topology-base-head.json`        | 1,423,952 | `00cba57437996afc48670918c9d67ff88fb045670ed214d12257a0f83bd4deff` |    104,418 | `73c3749452fb74a684af0dd866c5daf8c384401a654d991e8a3406304dd1962b` |
| `v500-explicit-calls-callbacks-base-head.json` | 1,079,728 | `632b5f677539eece4ccea6a301e75f386bb34bb17260d693065eddd6e9ec2f89` |     71,002 | `4f54dc3bf2c1a2db467c394d4b0488037b5337259e9a9afc11601656ea689bdc` |
| `v500-explicit-depth-4-16-base-head.json`      |   411,692 | `130dd7a4ce7fc9a2ec9ae5b0ca751066ab7912ee463fedac374367ed8106808e` |     30,987 | `f4d0598c4f91a546a44cff52eca0c70448b6b2a9812b32ce0b87295bc6fcb86e` |
| `v500-explicit-depth-12-base-head.json`        |   144,803 | `17ab199086f73a1f3d038fdfaed58f483130e3be21745da062a9dddd64fcf886` |     15,365 | `9f0fbadd2e06d058c1ee1e2c7ed3ad7f212b761dc4bebcfa8a3eb49aa118b24c` |
| `v500-mutation-base-head.json`                 |   530,095 | `6acc1dfeb9d2591d1fdc0dd2cea3ee85c143fb23ec766f6a792c993e8de20877` |     38,778 | `f72d74cd82b985258eb45ec386a77ead7e81f0aa05b818a8ab091913f3945a61` |
| `v500-warm-edit-base-head.json`                |   124,975 | `2220e01a4605767208cad8e62b3035afbcb18fbf4d0e4df5b627b0873252bf1e` |     12,697 | `52bdfb103fe594c0641f3c0c0674e4f3411625d924dc7bf2d5b769f033ae685e` |

Restore an artifact with:

```sh
gzip -dc v500-ordinary-fields-base-head.json.gz > /tmp/v500-ordinary-fields-base-head.json
```
