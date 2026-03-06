---
order: 130
---

# Runtime Diagnostics

Voyd can embed source metadata in the emitted Wasm so runtime traps can be
mapped back to Voyd functions and source spans.

## How it works

When runtime diagnostics are enabled, the compiler writes a Wasm custom section
named `voyd.runtime_diagnostics`. This section contains:

- Wasm function name
- Voyd module id
- Voyd function name
- Source span (file, byte offsets, and line/column when available)

At runtime, `@voyd/js-host` reads that section and attaches structured metadata
to trapped errors as `error.voyd`.

## SDK behavior

`@voyd/sdk` compile options include:

- `runtimeDiagnostics?: boolean`
- `optimize?: boolean`

Default behavior:

- Non-optimized builds: runtime diagnostics enabled
- Optimized builds (`optimize: true`): runtime diagnostics disabled

You can override explicitly:

```ts
import { createSdk } from "@voyd/sdk";
import { isVoydRuntimeError } from "@voyd/sdk/js-host";

const sdk = createSdk();
const result = await sdk.compile({
  source: `pub fn main() -> i32
  1 / 0
`,
  optimize: true,
  runtimeDiagnostics: true,
});

if (result.success) {
  try {
    await result.run({ entryName: "main" });
  } catch (error) {
    if (isVoydRuntimeError(error)) {
      console.error(error.voyd.trap.functionName);
      console.error(error.voyd.trap.span?.file);
      console.error(error.voyd.trap.span?.startLine);
    }
  }
}
```

## CLI behavior

`voyd --opt` compiles with optimization enabled, which disables runtime
diagnostics by default via SDK compile behavior.

## Getting the most out of it

- Use non-optimized builds while debugging trap-heavy issues.
- Keep runtime diagnostics enabled in integration tests that assert trap
  locations.
- Re-enable diagnostics on optimized builds when investigating production-only
  failures.
- Prefer `isVoydRuntimeError(error)` before reading `error.voyd`.
