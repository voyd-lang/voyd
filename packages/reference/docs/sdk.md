---
order: 16
---

# SDK

Use the SDK when you want to compile, run, or test Voyd code from JavaScript or
TypeScript.

## Installation

```bash
npm i @voyd-lang-lang/sdk
```

## Node usage

```ts
import { createSdk } from "@voyd-lang-lang/sdk";

const sdk = createSdk();
const result = await sdk.compile({
  source: `pub fn main() -> i32
  42
`,
});

if (!result.success) {
  console.error(result.diagnostics);
} else {
  const output = await result.run<number>({ entryName: "main" });
  console.log(output);
}
```

Compile from files by passing `entryPath`.

```ts
import { createSdk } from "@voyd-lang-lang/sdk";

const sdk = createSdk();
const result = await sdk.compile({
  entryPath: "./src/main.voyd",
  optimize: true,
});
```

In the SDK, `optimize: true` selects Voyd's aggressive validated optimization
profile.
Binaryen pass configuration is intentionally not exposed as public SDK API.

## Module roots and package resolution

`createSdk().compile(...)` accepts `roots` when you need to override module
resolution. In Node builds, the SDK also searches `node_modules` directories
from the source root up to the filesystem root.

```ts
const result = await sdk.compile({
  entryPath: "./src/main.voyd",
  roots: {
    src: "./src",
    pkgDirs: ["./vendor_pkgs"],
  },
});
```

## Running effectful programs

Compiled results expose effect metadata and accept host handlers.

```ts
const result = await sdk.compile({
  source: `@effect(id: "com.example.async")
eff Async
  await(resume, value: i32) -> i32

pub fn main(): Async -> i32
  Async::await(2) + 1
`,
});

if (result.success) {
  const output = await result.run<number>({
    entryName: "main",
    handlers: {
      "com.example.async::await": ({ resume }, value) =>
        resume(Number(value) + 10),
    },
  });
}
```

## Discovering and running tests

Set `includeTests: true` to collect tests.

```ts
const result = await sdk.compile({
  includeTests: true,
  source: `test "passes":
  1
`,
});

if (result.success && result.tests) {
  const summary = await result.tests.run({});
  console.log(summary);
}
```

## Browser usage

The browser entrypoint lives at `@voyd-lang-lang/sdk/browser`.

```ts
import { createSdk } from "@voyd-lang-lang/sdk/browser";

const sdk = createSdk();
const result = await sdk.compile({
  source: `pub fn main() -> i32
  7
`,
});
```

Browser builds require `source` input and do not support `optimize` or
`emitWasmText`.

## Documentation generation

The documentation generator lives at `@voyd-lang-lang/sdk/doc-generation`.

```ts
import { generateDocumentation } from "@voyd-lang-lang/sdk/doc-generation";

const { content } = await generateDocumentation({
  entryPath: "./src/pkg.voyd",
  format: "html",
});
```

## Related entrypoints

- `@voyd-lang-lang/sdk/browser`
- `@voyd-lang-lang/sdk/compiler`
- `@voyd-lang-lang/sdk/doc-generation`
- `@voyd-lang-lang/sdk/js-host`
