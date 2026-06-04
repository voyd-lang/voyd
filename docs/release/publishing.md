# Publishing

Voyd has two public release commands:

- `npm run release:prepare`
- `npm run release:publish`

Everything else in `scripts/release/` is an internal maintenance helper. The
documented release flow should go through the two root commands above.

## One-Time Setup

Before a full `--all` release can publish successfully:

- configure npm trusted publishing for each published npm package
- bootstrap any npm package that does not exist yet
- add the `VSCE_PAT` GitHub Actions secret for the VS Code Marketplace
- make sure the release workflow can create GitHub tags and releases

For `0.2.0`, the known blockers are:

- `VSCE_PAT` is not configured in GitHub Actions secrets
- `@voyd-lang/language-server` does not exist on npm yet
- `@voyd-lang/reference` does not exist on npm yet

See [GitHub and Token Setup](#github-and-token-setup) for the exact setup
steps.

## Release Flow

Prepare the release commit from a clean release branch:

```sh
git switch -c release/v0.2.0
npm run release:prepare -- --all --version 0.2.0
git push -u origin release/v0.2.0
```

Open and merge a pull request into `main`. This keeps branch protection and the
required `test` status check in front of the release commit.

After the PR is merged, update local `main` and publish:

```sh
git switch main
git pull --ff-only origin main
npm run release:publish -- --all
```

`release:publish` dispatches `.github/workflows/release.yml` on `main`. For a
real publish it also asks the workflow to create the GitHub tag and release. If
`docs/release/v<version>-notes.md` exists and all selected targets share the
same version, it is passed to the workflow automatically as the GitHub release
notes file.

Dry-run the workflow without publishing:

```sh
npm run release:publish -- --all --dry-run
```

Publish a subset:

```sh
npm run release:prepare -- --targets @voyd-lang/std,@voyd-lang/lib --version 0.2.0
npm run release:publish -- --targets @voyd-lang/std,@voyd-lang/lib
```

Skip GitHub release creation when publishing packages:

```sh
npm run release:publish -- --all --skip-github-release
```

Use an explicit notes file:

```sh
npm run release:publish -- --all --notes-file docs/release/v0.2.0-notes.md
```

## What The Commands Do

`release:prepare`:

- requires a clean non-`main` branch
- versions selected package manifests
- updates internal package ranges
- updates `packages/std/src/version.voyd` when `@voyd-lang/std` is selected
- refreshes `package-lock.json`
- runs the release validation suite
- stages and commits the release changes

Pass `--no-commit` to leave the release changes staged:

```sh
npm run release:prepare -- --all --version 0.2.0 --no-commit
```

`release:publish`:

- requires a clean, up-to-date local `main`
- checks selected npm packages already exist before dispatching a real trusted
  publishing release
- checks `VSCE_PAT` exists before dispatching a real `voyd-vscode` release
- dispatches the GitHub `Release` workflow on `main`
- passes package targets, dry-run mode, npm tag, VS Code release options, and
  GitHub release notes to the workflow

The GitHub workflow then:

- installs dependencies from the merged release commit
- runs release validation
- publishes npm packages in dependency order
- publishes the VS Code extension when selected
- creates the git tag and GitHub release for real publishes

## Supported Targets

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

Use `--all` to select every supported target. Use `--target` or `--targets` for
subsets.

## GitHub and Token Setup

### GitHub Actions Secret For VS Code

`voyd-vscode` publishes through `vsce`, which requires a Visual Studio
Marketplace personal access token.

Create the token:

1. Open `https://dev.azure.com/`.
2. Select the Azure DevOps organization that owns the Visual Studio Marketplace
   publisher.
3. Open the user settings menu next to your profile image.
4. Select **Personal access tokens**.
5. Select **New Token**.
6. Set **Name** to something like `voyd-vscode-release`.
7. Set **Organization** to **All accessible organizations**.
8. Set an expiration you are comfortable with.
9. Choose **Custom defined** scopes.
10. Click **Show all scopes**.
11. Under **Marketplace**, select **Manage**.
12. Click **Create**.
13. Copy the token immediately; Azure DevOps will not show it again.

Add it to GitHub as `VSCE_PAT`:

1. Open `https://github.com/voyd-lang/voyd/settings/secrets/actions`.
2. Click **New repository secret**.
3. Name it `VSCE_PAT`.
4. Paste the Azure DevOps token.
5. Save it.

Or use the GitHub CLI:

```sh
gh secret set VSCE_PAT --app actions -R voyd-lang/voyd
```

`release:publish -- --all` refuses to dispatch a real release until this secret
exists, because otherwise npm packages could publish before the VS Code publish
fails.

### npm Bootstrap For New Packages

Trusted publishing needs the package to exist on npm first. For `0.2.0`,
bootstrap these missing packages from the current `0.1.0` `main` before merging
the `0.2.0` release PR:

- `@voyd-lang/language-server`
- `@voyd-lang/reference`

Bootstrap from a clean, current `main` checkout:

```sh
git switch main
git pull --ff-only origin main
npm publish --workspace @voyd-lang/language-server --access public
npm publish --workspace @voyd-lang/reference --access public
```

Use your normal npm interactive login or a one-time npm automation token for
that bootstrap. After these packages exist at `0.1.0`, configure trusted
publishing for them, then let the release workflow publish `0.2.0`.

Do not bootstrap the missing packages at `0.2.0` before the release workflow.
If `0.2.0` already exists, the workflow cannot publish that same version.

Verify package existence:

```sh
npm view @voyd-lang/language-server version
npm view @voyd-lang/reference version
```

### npm Trusted Publishing

Voyd uses npm trusted publishing from GitHub Actions. That avoids long-lived npm
publish tokens for normal releases.

The release workflow must use npm CLI `11.5.1` or newer so `npm publish` can
authenticate through GitHub Actions OIDC. The workflow installs a compatible npm
version after `npm ci` and before publishing. Dependency installation still uses
the runner's bundled npm so `npm ci` stays compatible with the committed
lockfile.

For each npm package, configure trusted publishing on `npmjs.com`:

1. Open the package page while signed in as an owner/maintainer.
2. Go to **Settings**.
3. Find **Trusted publishing** or **Trusted Publisher**.
4. Choose **GitHub Actions** as the publisher.
5. Fill in:
   - **Organization or user**: `voyd-lang`
   - **Repository**: `voyd`
   - **Workflow filename**: `release.yml`
   - **Environment name**: leave blank
   - **Allowed actions**: allow `npm publish`
6. Save the trusted publisher.

Only set an npm trusted-publisher environment if the GitHub Actions job declares
the same `environment:` value. The Voyd release workflow does not currently use
a GitHub Actions environment, so the npm environment field should stay blank.

Configure these packages:


- `@voyd-lang/std`
- `@voyd-lang/lib`
- `@voyd-lang/compiler`
- `@voyd-lang/js-host`
- `@voyd-lang/sdk`
- `@voyd-lang/language-server`
- `@voyd-lang/reference`
- `@voyd-lang/cli`

`release:publish` refuses to dispatch a real workflow when selected npm targets
do not already exist. Bootstrap missing packages before using the release
workflow.

Verify trusted publishing by running a workflow dry-run after setup:

```sh
npm run release:publish -- --all --dry-run
```

### GitHub Release Permissions

The release workflow requests:

- `contents: write` to create tags and GitHub releases
- `id-token: write` for npm trusted publishing

The repository currently has protected `main` rules, so release commits should
go through pull requests. There is no direct-push release command.

## Watching A Release

After dispatch:

```sh
gh run list --workflow release.yml --limit 5
```

Open the newest run in GitHub Actions to watch package publishing and GitHub
release creation.
