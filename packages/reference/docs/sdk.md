---
order: 16
---

# SDK

Use the SDK when you want to compile, run, or test Voyd code from JavaScript or
TypeScript.

## Installation

```bash
npm i @voyd-lang/sdk
```

## Node usage

```ts
import { createSdk } from "@voyd-lang/sdk";

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
import { createSdk } from "@voyd-lang/sdk";

const sdk = createSdk();
const result = await sdk.compile({
  entryPath: "./src/main.voyd",
  optimizationLevel: "balanced",
});
```

`optimizationLevel` accepts:

- `"none"` (the default): no semantic optimizer or Binaryen optimization
- `"balanced"`: Voyd semantic optimization plus Binaryen's standard profile
- `"release"`: semantic optimization plus the aggressive release profile

The older `optimize` boolean remains compatible: `true` maps to `"release"`
and `false` maps to `"none"`. If both are supplied, `optimizationLevel` wins.
Raw Binaryen pass configuration is intentionally not public SDK API.

## Typed JavaScript boundary exports

SDK builds automatically expose boundary-compatible public Voyd functions
through the existing host and compiled-result run APIs. JavaScript callers pass
plain JS values; the host validates and encodes them at the Wasm boundary.
Primitive-only signatures use a validated direct Wasm call and do not pull in
the serialized boundary runtime. Strings, arrays, records, and unions continue
to use the serialized boundary ABI.

```ts
const result = await sdk.compile({
  source: `use std::array::Array
use std::enums::{ enum }
use std::string::type::String

obj Point {
  x: i32,
  y: i32
}

enum LookupResult
  Found { value: String }
  Missing

pub fn translate(point: Point, dx: i32, dy: i32) -> Point
  Point { x: point.x + dx, y: point.y + dy }

pub fn get_point() -> { x: i32, y: i32 }
  { x: 1, y: 2 }

pub fn lookup(key: String) -> LookupResult
  if key == "name" then:
    LookupResult::Found { value: "Ada" }
  else:
    LookupResult::Missing {}

pub fn sum_values(values: Array<i32>) -> i32
  var index = 0
  var total = 0
  while index < values.len():
    total = total + values.at(index)
    index = index + 1
  total
`,
});

if (result.success) {
  await result.run({ entryName: "translate", args: [{ x: 1, y: 2 }, 10, 20] });
  // { x: 11, y: 22 }

  await result.run({ entryName: "get_point" });
  // { x: 1, y: 2 }

  await result.run({ entryName: "lookup", args: ["name"] });
  // { tag: "Found", value: "Ada" }

  await result.run({ entryName: "sum_values", args: [[1, 2, 3]] });
  // 6
}
```

Supported DTO shapes include booleans, numeric primitives, strings, arrays,
records/objects with public boundary-compatible fields, structural records, and
named enum/union variants represented in JS as `{ tag: "Variant", ...fields }`.
`f32` and `f64` values accept any JavaScript number, including `NaN` and
`Infinity`; integer values must be finite and in range.
Unsupported public functions are skipped in automatic mode. Explicit requests
can surface diagnostics:

```ts
await sdk.compile({
  source: `${source}
pub fn call_callback(callback: fn() -> i32) -> i32
  callback()
`,
  boundaryExports: {
    mode: "only",
    include: ["call_callback"],
    onUnsupported: "diagnostic",
  },
});
```

Disable automatic boundary generation when raw Wasm calling conventions are
preferred over JavaScript validation and DTO conversion.

```ts
const result = await sdk.compile({
  source,
  boundaryExports: false,
});
```

Raw Wasm exports remain available through `host.instance.exports`. Existing
raw MsgPack interop still works; MsgPack is an internal codec detail for typed
boundary exports, not a stable WIT/component-model replacement.

Raw Wasm GC objects and closures are opaque boundary handles. A host may retain
them and pass the same reference back to Voyd exports, but inspecting their
fields, invoking embedded function references, constructing compatible GC
values, or reflecting on their runtime types is outside the supported ABI.

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

The browser entrypoint lives at `@voyd-lang/sdk/browser`.

```ts
import { createSdk } from "@voyd-lang/sdk/browser";

const sdk = createSdk();
const result = await sdk.compile({
  source: `pub fn main() -> i32
  7
`,
  optimizationLevel: "balanced",
});
```

Browser builds require `source` input. They support the same optimization
levels and legacy `optimize` switch as Node builds, but not `emitWasmText`.

## Documentation generation

The documentation generator lives at `@voyd-lang/sdk/doc-generation`.

```ts
import { generateDocumentation } from "@voyd-lang/sdk/doc-generation";

const { content } = await generateDocumentation({
  entryPath: "./src/pkg.voyd",
  format: "html",
});
```

## Related entrypoints

- `@voyd-lang/sdk/browser`
- `@voyd-lang/sdk/compiler`
- `@voyd-lang/sdk/doc-generation`
- `@voyd-lang/sdk/js-host`
