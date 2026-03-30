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
- refresh `package-lock.json`

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
  - `@voyd-lang/smoke` for runtime-facing packages
  - CLI dist e2e for CLI/runtime packages
- run `npm pack --dry-run` and verify the published tarball contains only the expected files

Direct `npm publish` is also guarded via `prepublishOnly`, so per-package
publishes still enforce the related checks.

## Publishing

### GitHub Actions Auth

The GitHub release workflow uses npm trusted publishing for npm packages.

GitHub setup:

- configure each published npm package as a trusted publisher for the `voyd-lang/voyd` repository and `.github/workflows/release.yml`
- do not set `NPM_TOKEN` for this workflow
- keep `VSCE_PAT` as a GitHub Actions secret if you want CI to publish `voyd-vscode`

Notes:

- npm trusted publishing only works after the package already exists on npm, so the first publish may still need a token-based/manual bootstrap
- the workflow has `id-token: write` enabled so npm can verify the GitHub OIDC identity during publish
- the VS Code extension does not have an equivalent trusted-publisher flow in this repo today; CI still uses `VSCE_PAT`

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
