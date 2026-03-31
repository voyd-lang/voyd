---
order: 130
---

# Runtime Diagnostics

Voyd can embed source metadata in generated Wasm so runtime traps map back to
Voyd functions and spans.

## What gets recorded

When runtime diagnostics are enabled, the compiler writes a Wasm custom section
named `voyd.runtime_diagnostics` containing trap metadata such as:

- Voyd module id
- Voyd function name
- source file and span information

`@voyd-lang/js-host` and `@voyd-lang/sdk` read that section and attach structured data to
runtime errors.

When a program calls `std::error::panic(message)`, the runtime also preserves
that human-readable message in the structured diagnostics when the host can
read it. If transport fails at the lowest level, diagnostics report that the
panic message was unavailable instead of silently dropping it.

## SDK behavior

`@voyd-lang/sdk` supports:

- `optimize?: boolean`
- `runtimeDiagnostics?: boolean`

Default behavior:

- non-optimized builds enable runtime diagnostics
- optimized builds enable Voyd's aggressive validated optimization profile and disable
  runtime diagnostics unless you opt back in

## CLI behavior

`voyd --opt` follows the same SDK default and therefore disables runtime
diagnostics unless the compile call is overridden elsewhere.

## Usage advice

- Leave diagnostics enabled while debugging traps.
- Re-enable them for optimized builds when investigating production-only
  failures.
- Check `isVoydRuntimeError(error)` before reading `error.voyd`.
- Read `error.voyd.panic` when you need the original `panic(message)` text or
  an explicit reason the message could not be recovered.
