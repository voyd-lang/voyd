# Codegen Diagnostics Boundary (No Semantics Mutation)

Status: Proposed  
Owner: Compiler Architecture Working Group  
Scope: `packages/compiler/src/codegen/*`, `packages/compiler/src/pipeline.ts`, tests

## Goal

Prevent codegen from mutating semantics artifacts (especially `BindingResult.diagnostics`) and make diagnostics ownership and lifecycle explicit at the pipeline boundary.

## Problem

Today codegen can push diagnostics directly into `ctx.module.binding.diagnostics` (a semantics/binding-owned structure). This creates:

- hidden coupling between codegen and binding internals,
- unclear diagnostic ownership (binding vs semantics vs codegen),
- correctness risk (codegen can emit diagnostics that appear to be “binding diagnostics”),
- harder-to-test behavior (diagnostics are side effects rather than outputs).

## Proposal

### New Rule

Codegen must be **pure with respect to semantics artifacts**:

- It may read from `ProgramCodegenView` only.
- It must not mutate any part of `SemanticsPipelineResult` or `BindingResult`.
- All codegen diagnostics are produced as codegen output.

### API Shape

- Add `diagnostics: Diagnostic[]` to `CodegenResult` (or a `DiagnosticEmitter` that returns an immutable list).
- Add a `diagnostics` sink to `CodegenContext` so codegen can report errors without reaching into semantics/binding.
- `compileProgram` / `emitProgram` merges diagnostics:
  - `diagnostics = [...semanticsDiagnostics, ...codegenDiagnostics]`

### Diagnostics and Errors

Use a consistent policy:

- Prefer *diagnostic output* over throwing for user-facing errors (e.g. unsupported export shapes).
- Throw only for programmer errors / invariant violations (e.g. missing type information that should be impossible).

## Migration Plan (Single PR)

1. Introduce `CodegenResult.diagnostics`.
2. Thread `diagnostics` into `CodegenContext`.
3. Replace all `ctx.module.binding.diagnostics.push(...)` style writes with codegen-owned diagnostic emission.
4. Update pipeline result merging and tests.

## Success Criteria

- No writes to `binding.diagnostics` from codegen.
- All existing tests pass.
- At least one test asserts that a codegen diagnostic appears in the pipeline diagnostics output (not inside binding).
