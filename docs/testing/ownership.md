# Test Ownership

Voyd separates tests by the contract they protect. Tests are not collected in
one directory: implementation tests stay beside their implementation, while
portable language behavior and cross-package behavior have dedicated suites.

## Placement Rule

Ask whether a different Voyd compiler implementation should pass the test
unchanged.

- If yes, put the observable expectation in `tests/conformance`.
- If no, put the test beside the implementation it describes.
- If the behavior only exists when several public packages are composed, put
  it in `tests/integration`.

A feature commonly has focused compiler units plus one representative
conformance case. This is intentional boundary coverage, not duplication.

## Ownership Matrix

| Layer                                  | Owns                                                                                                                          | Avoid                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/compiler`                    | Parser, binding, typing, lowering, optimization, codegen internals, compiler-only contracts                                   | CLI behavior and portable expectations expressed through internal data structures |
| `tests/conformance`                    | Source acceptance/rejection, stable diagnostic codes, runtime results and traps, module semantics, required Wasm ABI behavior | Compiler-internal imports, HIR/AST layouts, SDK-specific lifecycle behavior       |
| `tests/integration`                    | SDK + compiler + std + host composition, filesystem/network adapters, packaging, VX DOM, web                                  | Fine-grained compiler algorithms or CLI argument parsing                          |
| `packages/sdk`                         | Public SDK result shapes, option translation, caching, lifecycle and adapter contracts                                        | General language semantics and std behavior                                       |
| `apps/cli`                             | Arguments, command dispatch, formatting, exit status, process and distribution wiring                                         | Re-validating SDK/compiler semantics through subprocesses                         |
| `packages/std` and other Voyd packages | Library behavior in co-located `*.test.voyd` files                                                                            | Compiler implementation assertions                                                |
| `tests/performance`                    | Benchmarks, large external regression programs and explicit performance gates                                                 | Required default correctness coverage                                             |

## Overlap Policy

Overlap is allowed only when tests fail at different boundaries. The canonical
owner should carry semantic depth; non-canonical layers should retain the
smallest signal that proves their wiring.

Examples:

- Compiler units verify constraint generation; conformance runs one program
  showing the language feature works.
- SDK tests verify a `pkgDirs` option is translated; conformance owns module
  visibility; integration owns a real installed package.
- CLI tests verify `--pkg-dir` is forwarded; they do not repeat the full
  package-resolution matrix.

When adding overlapping coverage, name the canonical owner and the distinct
boundary in the PR description.
