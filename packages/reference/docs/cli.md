---
order: 15
---

# CLI

Voyd ships with the `voyd` CLI. In a linked repository checkout, `vt` points at
the development entrypoint and accepts the same arguments.

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
voyd --run-wasm --entry custom_main ./dist/module.wasm
```

## Emit wasm binary

```bash
voyd --emit-wasm > module.wasm
voyd --emit-wasm ./custom_src > module.wasm
voyd --emit-wasm --opt ./src/main.voyd
```

`--opt` runs the standard Binaryen optimization pass.

## Inspect compiler output

```bash
voyd --emit-parser-ast ./src/main.voyd
voyd --emit-core-ast ./src/main.voyd
voyd --emit-ir-ast ./src/main.voyd
voyd --emit-wasm ./src > module.wasm
voyd --emit-wasm-text --opt ./src/main.voyd
```

`--opt` runs the standard Binaryen optimization pass.

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

## Generate API documentation

```bash
voyd doc
voyd doc --out docs.html
voyd doc --format json --out api-docs.json
voyd docs ./demo --out docs.html
```

- `docs` is an alias for `doc`.
- The default output file is `docs.html` for HTML and `docs.json` for JSON.

## Help and version

```bash
voyd --help
voyd doc --help
voyd --version
```

## Current caveat

CLI help currently exposes `-m, --msg-pack`, but the option is not wired to any
runtime behavior yet.
