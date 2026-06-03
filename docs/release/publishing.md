# Publishing

Voyd publishes through the root release scripts instead of ad hoc `npm publish`
commands.

## Supported Targets

List release targets:

```sh
npm run release:list
```

Current supported targets:

- `@voyd-lang/std`
- `@voyd-lang/lib`
- `@voyd-lang/compiler`
- `@voyd-lang/js-host`
- `@voyd-lang/sdk`
- `@voyd-lang/language-server`
- `@voyd-lang/reference`
- `@voyd-lang/cli`
- `voyd-vscode`

`voyd_semver` is intentionally private and excluded from the release flow.

Use `--all` to select every supported target without listing them explicitly.
The GitHub release workflow accepts the same `--all` value in its `targets` input.

## Full Release With Protected `main`

Use the protected-branch flow when `main` requires pull requests.

Prepare the release commit from a clean release branch:

```sh
git switch -c release/v0.2.0
npm run release:prepare -- --all --version 0.2.0
git push -u origin release/v0.2.0
```

Open and merge a pull request into `main`. After the PR lands, dispatch the
GitHub release workflow from the merged `main` commit:

```sh
gh workflow run release.yml \
  --ref main \
  --raw-field targets=--all \
  --raw-field dry_run=false \
  --raw-field npm_tag=latest \
  --raw-field github_release=true \
  --raw-field github_release_notes_file=docs/release/v0.2.0-notes.md
```

This flow:

- keeps branch protection in front of release commits
- versions selected packages and internal dependency ranges
- updates `packages/std/src/version.voyd` when `@voyd-lang/std` is selected
- refreshes `package-lock.json`
- runs the release validation suite before the PR is opened
- publishes from the exact commit that was merged to `main`
- asks the workflow to publish packages, create the git tag, and create the
  GitHub release

`release:prepare` commits by default. Pass `--no-commit` to leave the release
changes staged for manual review:

```sh
npm run release:prepare -- --all --version 0.2.0 --no-commit
```

## Direct-Main Release

`release:cut` is only for maintainers who can push directly to `main`, such as
repositories without branch protection or accounts with bypass rights:

```sh
npm run release:cut -- --all --version 0.2.0 --publish --github-release --github-release-notes-file docs/release/v0.2.0-notes.md
```

That command verifies the worktree is clean, verifies local `main` matches
`origin/main`, versions packages, runs validation, commits, pushes `main`, and
dispatches the GitHub `Release` workflow. It will fail on protected branches
when direct pushes to `main` are not allowed.

The lower-level commands below are useful for manual recovery, partial
publishes, and debugging.

## Versioning

Bump every supported target by one patch version:

```sh
npm run release:version:all -- --bump patch
```

Bump a subset:

```sh
npm run release:version -- --targets @voyd-lang/sdk,@voyd-lang/cli --bump minor
```

Set an exact version instead:

```sh
npm run release:version -- --all --version 0.2.0
```

Version updates:

- rewrite the selected targets' own `version` fields
- update internal workspace dependency ranges that point at those targets
- update `packages/std/src/version.voyd` when `@voyd-lang/std` is selected
- refresh `package-lock.json`

Commit version updates before publishing. The GitHub release workflow publishes
the checked-out commit; it does not create an uncommitted version bump for you.

## Validation

Before publishing, run:

```sh
npm run release:check -- --target @voyd-lang/sdk
```

Or validate several targets together:

```sh
npm run release:check -- --targets @voyd-lang/std,@voyd-lang/lib,@voyd-lang/sdk,@voyd-lang/cli
```

Release checks always:

- run uncached Turbo builds for the selected targets and their dependency closure
- run each selected target's own `typecheck` and `test` scripts
- run shared boundary suites when needed:
  - compiler codegen tests for compiler/runtime-facing packages
  - `@voyd-lang/smoke` for runtime-facing packages
  - CLI dist e2e for CLI/runtime packages
- run `npm pack --dry-run` and verify the published tarball contains only the expected files

Direct `npm publish` is also guarded via `prepublishOnly`, so per-package
publishes still enforce the related checks.

## Publishing

### GitHub Actions Auth

The GitHub release workflow uses npm trusted publishing for npm packages. This
is the preferred publishing path because npm verifies the GitHub Actions OIDC
identity for this repository and workflow, avoiding long-lived npm publish
tokens.

GitHub setup:

- configure each published npm package as a trusted publisher for the `voyd-lang/voyd` repository and `.github/workflows/release.yml`
- do not set `NPM_TOKEN` for this workflow
- keep `VSCE_PAT` as a GitHub Actions secret if you want CI to publish `voyd-vscode`; it is required for `--all`
- ensure GitHub Actions can create tags and releases with `contents: write`
- ensure no protected tag rule blocks release tags such as `v0.2.0`

Notes:

- npm trusted publishing only works after the package already exists on npm, so the first publish may still need a token-based/manual bootstrap
- real publishes fail before any package is published when a selected npm target is not already on npm and no `NPM_TOKEN`/`NODE_AUTH_TOKEN` bootstrap is present
- the workflow has `id-token: write` enabled so npm can verify the GitHub OIDC identity during publish
- the VS Code extension does not have an equivalent trusted-publisher flow in this repo today; CI still uses `VSCE_PAT`
- the publish script fails before publishing npm packages when `voyd-vscode` is selected for a real publish and `VSCE_PAT` is missing
- when `voyd-vscode` is selected without `vscode_release`, the workflow publishes the version already committed in `apps/vscode/package.json`

### GitHub Releases

Create a GitHub release after the package publish succeeds:

```sh
npm run release:github -- --all
```

That command infers `v<version>` from the selected targets, verifies the tag
exists, and runs `gh release create`. To create and push the tag as part of the
same step:

```sh
npm run release:github -- --all --create-tag
```

Use an explicit tag or notes when needed:

```sh
npm run release:github -- --all --github-tag v0.2.0 --notes-file release-notes.md
```

The GitHub Actions workflow has an optional `github_release` input. When enabled
on a non-dry-run publish, it runs the same helper after publishing. Leave
`github_tag` blank to use `v<version>` or pass one explicitly.

Dry-run a publish:

```sh
npm run release:publish -- --targets @voyd-lang/std,@voyd-lang/lib,@voyd-lang/sdk --dry-run
```

Dry-run every supported target:

```sh
npm run release:publish:all -- --dry-run
```

Publish npm packages:

```sh
npm run release:publish -- --targets @voyd-lang/std,@voyd-lang/lib,@voyd-lang/sdk,@voyd-lang/cli
```

Version-bump and publish every supported target in one go:

```sh
npm run release:publish:all -- --bump patch
```

Notes:

- The publish script requires a clean git worktree unless `--allow-dirty` is passed.
- `--bump patch|minor|major` and `--version x.y.z` can be used with `release:publish` to update versions before validation and publishing.
- npm targets publish in dependency order.
- The script reuses the release validation pass, then skips duplicate `prepublishOnly`
  work during the actual publish step.
- If `voyd-vscode` is included and you already used `--bump` or `--version`, the extension publishes its current package version without a second version bump.

Publish the VSCode extension:

```sh
npm run release:publish -- --target voyd-vscode --vscode-release patch
```

Equivalent workspace shortcuts are available in `apps/vscode/package.json`:

- `npm run --workspace voyd-vscode publish:patch`
- `npm run --workspace voyd-vscode publish:minor`
- `npm run --workspace voyd-vscode publish:major`

Those shortcuts enforce the same clean-worktree rule. Pass `-- --allow-dirty` only
if you intentionally need to bypass it.
