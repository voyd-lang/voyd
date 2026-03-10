# Voyd

Voyd is a programming language that compiles to WebAssembly. The project sits
between Rust and TypeScript in abstraction level: explicit enough to stay
predictable, high-level enough to build real applications without fighting the
runtime.

```voyd
fn fib(n: i32) -> i32
  if n < 2:
    n
  else:
    fib(n - 1) + fib(n - 2)

pub fn main() -> i32
  fib(10)
```

## Status

Voyd is pre-release and not ready for production use yet. Expect breaking
changes while the language, runtime, and tooling continue to settle.

## Highlights

- Compiles to WebAssembly
- Structural and nominal types
- Traits and generic constraints
- Algebraic effects
- Macros used for real surface-language features
- CLI, SDK, language server, docs site, and VSCode extension in one repo

## Install and try it

Install the CLI:

```bash
npm i -g @voyd/cli
```

Run a program:

```bash
voyd --run ./src/main.voyd
```

Compile a program:
```bash
voyd --emit-wasm ./src
```

Inspect compiler output:

```bash
voyd --emit-ir-ast ./src/main.voyd
voyd --emit-wasm-text --opt ./src/main.voyd
```

Generate API documentation:

```bash
voyd doc --out docs.html
```

## Use the SDK

For JavaScript or TypeScript integrations, use the SDK:

```bash
npm i @voyd-lang/sdk
```

```ts
import { createSdk } from "@voyd-lang/sdk";

const sdk = createSdk();
const result = await sdk.compile({
  source: `pub fn main() -> i32
  42
`,
});

if (result.success) {
  const value = await result.run<number>({ entryName: "main" });
  console.log(value);
}
```

See [packages/reference/docs/sdk.md](./packages/reference/docs/sdk.md) for more.

## Documentation

- Language reference: [packages/reference/docs](./packages/reference/docs)
- Local docs site: `http://localhost:5173/docs`
- Architecture note: [docs/architecture/codegen-semantics-boundary.md](./docs/architecture/codegen-semantics-boundary.md)

## Monorepo layout

- `apps/cli`: `voyd` / `vt` command line entrypoints
- `apps/smoke`: end-to-end smoke tests
- `apps/site`: `voyd.dev` docs and playground
- `apps/vscode`: VSCode extension
- `packages/compiler`: parser, semantics, and Wasm codegen
- `packages/language-server`: LSP server
- `packages/sdk`: public compile/run/test APIs
- `packages/lib`: shared runtime and tooling helpers
- `packages/js-host`: JS host runtime for executing compiled modules
- `packages/std`: standard library source bundle
- `packages/reference`: language reference source and generated nav bundle

## Develop locally

Install workspace dependencies:

```bash
npm install
```

Useful commands:

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

Voyd-specific helpers:

```bash
vt --emit-parser-ast ./path/to/file.voyd
vt --run ./path/to/file.voyd
vt --emit-wasm-text --opt ./path/to/file.voyd
```

## Contributing

The codebase is organized around a clear compiler boundary: semantics produce a
codegen view, and Wasm codegen consumes that view rather than typing internals.
If you are changing the compiler, start with
[docs/architecture/codegen-semantics-boundary.md](./docs/architecture/codegen-semantics-boundary.md).
