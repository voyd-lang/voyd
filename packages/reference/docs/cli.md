---
order: 15
---

# CLI

Voyd ships with the `voyd` CLI.

## Installation

```bash
npm i -g @voyd-lang/cli
```

## Basic usage

```bash
voyd --run
voyd --emit-wasm --opt > out.wasm
voyd --run-wasm out.wasm
```

## Entry paths

Most commands accept an optional `[index]` argument.

- If omitted, the default is `./src`.
- If the path is a directory, the CLI looks for `main.voyd`, then `pkg.voyd`.
- `voyd test` defaults to the current directory instead of `./src`.

## Run source code

```bash
voyd --run ./src/main.voyd
voyd --run ./src
voyd --run --entry custom_main ./src/main.voyd
```

## Run an existing Wasm module

```bash
voyd --run-wasm ./dist/module.wasm
voyd --run-wasm ./dist/module.wasm --entry custom_main
```

## Emit wasm binary

```bash
voyd --emit-wasm > module.wasm
voyd --emit-wasm ./custom_src > module.wasm
voyd --emit-wasm --opt ./src/main.voyd
```

`--opt` is shorthand for the release profile. Use `--opt-level balanced` for a
lower compile-time-cost optimized build, or `--opt-level none` to select the
default unoptimized build explicitly. `--opt` and `--opt-level` cannot be used
together.

## Inspect compiler output

```bash
voyd --emit-parser-ast ./src/main.voyd
voyd --emit-core-ast ./src/main.voyd
voyd --emit-ir-ast ./src/main.voyd
voyd --emit-wasm ./src > module.wasm
voyd --emit-wasm-text --opt ./src/main.voyd
```

The optimization flags apply equally to binary emission, Wasm text emission,
and `--run`.

## Run tests

```bash
voyd test
voyd test ./tests --reporter silent
voyd test ./tests --fail-empty-tests
voyd test ./workspace/apps/consumer/test --pkg-dir ../pkgs
```

`--pkg-dir <path>` is repeatable. For normal commands it is resolved relative
to the target source root. For `voyd test`, it is resolved relative to the test
root.

Package directories shared by the CLI and editor can be declared in
`package.json`:

```json
{
  "voyd": {
    "packageDirectories": ["./voyd-packages"]
  }
}
```

Configured paths are resolved relative to the `package.json` that declares
them. Configuration is inherited from ancestor manifests, with nearer
manifests searched first. Explicit `--pkg-dir` values are searched before
configured directories, followed by ancestor `node_modules` directories.

## Generate API documentation

```bash
voyd doc
voyd doc --out docs.html
voyd doc --format json --out api-docs.json
voyd docs ./demo --out docs.html
```

- `docs` is an alias for `doc`.
- The default output file is `docs.html` for HTML and `docs.json` for JSON.

## Generate package adapters

Generate the TypeScript contract and WIT interface for a package containing
`@external` functions and effects:

```bash
voyd generate adapter ./src --out ./generated
```

Generate the static adapter imports needed by a browser application:

```bash
voyd generate registry ./src/main.voyd \
  --out ./src/generated/voyd-adapters.ts
```

The adapter generator compiles the package's canonical `pkg.voyd` graph and
emits every re-exported `@external` declaration. Legacy source folders without
a package root fall back to individual declaration files. The registry
generator compiles the application, selects only reachable external
interfaces, and resolves their installed npm providers.

See [External Packages](./external-packages.md) for the package format and
authoring workflow.

## Help and version

```bash
voyd --help
voyd doc --help
voyd generate adapter --help
voyd --version
```

## Current caveat

CLI help currently exposes `-m, --msg-pack`, but the option is not wired to any
runtime behavior yet.
