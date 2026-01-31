# Diagnostics: Adding and Updating Codes

This doc describes the standard workflow for adding or modifying compiler diagnostics.

Diagnostics live in:
- `packages/compiler/src/diagnostics/registry.ts` (codes, params, default message/severity/hints)
- `packages/compiler/src/diagnostics/index.ts` (creation/emission helpers, phase inference)

## Terminology

- **`code`**: The stable identifier for a diagnostic family (example: `TY0021`). Treat this as the user-facing / tool-facing boundary: it’s what people will search for, filter on, and reference in issues.
- **`kind`**: A variant inside a code. Used to select a message and to type-check `params` precisely.
- **`params`**: The typed payload for a diagnostic. Encoded via `DiagnosticParamsMap[code]` and usually discriminated by `params.kind`.
- **`definition`**: The registry entry providing `message`, plus optional defaults like `severity`, `phase`, and `hints`.
- **`related`**: Additional diagnostics (often `note`s) attached to a primary diagnostic for “declared here”, “previous definition”, etc.

## New code vs. new kind

### Add a **new code** when

- The underlying error category is different (different root cause and different fix).
- You expect users/tools to want independent filtering/suppression/telemetry for it.
- The parameter shape would be unrelated to existing variants under the code.
- Reusing the code would make it misleading (e.g. “call argument count mismatch” vs “generic type argument mismatch”).

Practical rule: if you’d want it to show up as a different entry in release notes or documentation, it should be a different `code`.

### Add a **new kind** under an existing code when

- The diagnostic is still the same “family” and it’s useful to group variants together.
- You’re adding **related notes** that exist only to support a primary diagnostic (common pattern).
- You’re refining message variants but still want them to be one externally-visible bucket.

Practical rule: if you’d be happy filtering them together by `code`, prefer a new `kind`.

## Procedure (checklist)

1. **Pick the code**
   - Choose the right prefix (`MD`, `BD`, `TY`, `CG`, etc). Phase is inferred from the prefix in `packages/compiler/src/diagnostics/index.ts`.
   - Pick the next available numeric suffix for that prefix (don’t reuse old numbers; codes should stay stable once referenced).

2. **Add the params type**
   - Update `DiagnosticParamsMap` in `packages/compiler/src/diagnostics/registry.ts`.
   - Prefer a single `{ kind: "..." }` shape per code unless you know you need multiple variants (including `note` variants).

3. **Add the registry definition**
   - Add a `diagnosticsRegistry[CODE]` entry with:
     - `code`
     - `message: (params) => string`
     - optional defaults: `severity`, `phase`, `hints`
   - If the code has multiple variants, prefer an exhaustive `switch (params.kind)` and end with `exhaustive(params)` so adding a new `kind` forces message updates.

4. **Emit from the compiler**
   - For “this is a hard error”, use `emitDiagnostic({ ctx, code, params, span, ... })`.
   - For “collect and continue” flows, construct diagnostics with `diagnosticFromCode(...)` and push them onto a diagnostics array (common in binder/module-graph).
   - Attach context with `related` diagnostics when pointing to additional spans is helpful.

5. **Add tests**
   - If the diagnostic has special formatting or `hints`, add/extend tests in `packages/compiler/src/diagnostics/__tests__/diagnostics.test.ts`.
   - Add an integration-ish test that triggers the diagnostic through the pipeline and asserts `diag.code === "..."` (see `packages/compiler/src/__tests__` for patterns).

## Message and hint guidelines

- Keep primary `message` short and actionable; include the user-relevant name(s) (type name, parameter label, etc).
- Prefer consistent casing and phrasing across diagnostics (most messages are sentence fragments without a trailing period).
- Use `hints` when there is a reliable next step (a concrete “do X” suggestion).

