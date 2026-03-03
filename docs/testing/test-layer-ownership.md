# Test-Layer Ownership

## Purpose

Voyd tests are split across compiler, SDK, CLI, and smoke layers. This guide defines where new tests belong, when overlap is allowed, and how to keep runtime under control.

## Ownership Matrix

| Layer | Owns | Avoid in this layer |
| --- | --- | --- |
| `packages/compiler` | Parser, semantics, lowering, codegen internals, diagnostics, and compiler contracts | CLI process behavior and public end-to-end product flows |
| `packages/sdk` | Public compile/run/test APIs, runtime host adapter contracts, module root resolution APIs | Deep CLI UX assertions and implementation-detail compiler internals |
| `apps/cli` | Flag parsing, command dispatch, output/exit behavior, CLI-only wiring to SDK/test runner/doc generation | Re-validating SDK semantics already covered in SDK/smoke |
| `apps/smoke` | Public end-to-end user flows across packages (`@voyd/sdk`, std, js-host) | Fine-grained CLI option parsing and compiler-private behavior |

## Canonical Placement For Common Scenarios

- Compiler semantics and diagnostics: `packages/compiler`.
- Codegen ABI/runtime metadata contracts: `packages/compiler`.
- SDK compile/run APIs and host default adapters: `packages/sdk`.
- CLI command/flag UX (`--help`, `--pkg-dir`, reporter, exit codes): `apps/cli`.
- Cross-package integration and public behavior (real fixtures, std, package installs): `apps/smoke`.

## Overlap Policy

Overlap is allowed only for boundary protection.

Allowed overlap examples:
- SDK proves a behavior contract; smoke validates the same behavior through a real multi-package fixture.
- CLI checks that a flag is forwarded correctly; SDK/smoke own the underlying semantics.

Required when overlap exists:
- Name the boundary being protected.
- Identify the canonical owner layer.
- Keep non-canonical checks minimal (wiring/smoke signal only).

## March 2026 Audit: Overlap Hotspots

Measured hotspots (local run):
- `apps/cli/src/__tests__/cli-e2e.test.ts`: ~77s
- `packages/sdk/src/__tests__/compiler-browser-bundle-smoke.test.ts`: ~20s
- `apps/smoke/src/wasm-validation.test.ts`: ~9s

Scenarios consolidated in this issue:
- Package resolution semantics (`node_modules` default + ancestor walking): canonical in `packages/sdk` + `apps/smoke`; removed from CLI e2e.
- Doc rendering semantics/content: canonical in SDK doc-generation + smoke doc-generation; CLI e2e now checks command wiring/output path.

## Test Addition Checklist

Before adding a test, answer all items:

1. Which layer owns this behavior?
2. Is there already a canonical test for this behavior in another layer?
3. If duplicating, what boundary is being protected?
4. Is this assertion about semantics or about wiring/UX?
5. What is the expected runtime cost and can it be batched with existing expensive setup?

If any answer is unclear, stop and document rationale in PR/issue notes before adding the test.

## Performance Standards (Preventing Test Bloat)

- Prefer one expensive integration setup with multiple assertions over many near-identical expensive tests.
- Keep CLI e2e focused on CLI ownership; move semantic depth to SDK/smoke.
- Reuse fixtures and compiled modules where practical.
- Avoid adding duplicate compile-heavy tests across layers.
- For new compile-heavy suites, record before/after timing in PR notes.
- If a single file consistently exceeds ~15s locally, split intent (fast checks vs deep e2e) or reduce redundant scenarios.

## Kitchen-Sink Guidance

Kitchen-sink tests are acceptable only when setup dominates runtime and assertions share the same boundary. Use them to batch expensive setup, but keep each assertion tied to a clear expectation and avoid turning one test into unrelated behavior coverage.
