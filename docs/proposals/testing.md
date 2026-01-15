# Voyd Testing System Spec (`spec.md`)

This document specifies Voyd’s first-class testing system: syntax, discovery, execution, CLI behavior, reporting, and extension points.

The design goals are:

* **Colocation-first**: tests can live *in the same module file* or in a co-located `*.test.voyd` companion file.
* **Clear boundaries**: unit tests can be white-box; integration tests are black-box.
* **Effects-aware**: tests integrate cleanly with Voyd’s effect system and encourage explicit handling.
* **Minimal core**: a small, stable surface area in the language + standard library; richer features live in libraries and reporters.

---

## 1. Scope

### 1.1 Included

* In-source **`test` blocks** in any `.voyd` source file.
* Co-located **`*.test.voyd`** files for larger unit test suites.
* Top-level **`test/`** directory for integration tests.
* A minimal `std::test` API (assertions + failure reporting).
* `voyd test` CLI: discovery, filtering, execution, reporting.
* Extension points for third-party reporters and runners.

### 1.2 Explicitly not included (for now)

* Doctests (tests embedded in documentation comments).
* Property testing, fuzzing, snapshot testing (library territory).
* Compiler-negative tests (compile-fail UI tests) as a language feature.

This spec **reserves room** to add doctests later without breaking the model (see §12).

---

## 2. Terminology

* **Package**: a buildable unit with a `src/` directory and optional `test/` directory.
* **Module**: a compilation unit resolved from the module tree under `src/`.
* **Unit test**: tests that may access **private** items within a module.
* **Integration test**: tests compiled separately that can access only **public** items of the package under test.
* **Test case**: a single runnable test with a name, source location, and result.

---

## 3. Directory Layout and File Conventions

A Voyd package may contain:

* `src/` — primary source code
* `test/` — integration tests (black-box), optional

Within `src/`:

* `*.voyd` — normal source files
* `*.test.voyd` — **test companion files**, compiled only in test builds

Within `test/`:

* `*.voyd` — integration test modules, compiled only in test builds

---

## 4. Test Discovery Rules

### 4.1 In-source tests (`test` blocks)

Any `test` block inside:

* `src/**/*.voyd`
* `test/**/*.voyd`

is discovered as a test case.

### 4.2 Companion test files (`*.test.voyd`)

Any file matching `src/**/*.test.voyd` is treated as a **test companion** to a corresponding module file:

* `src/foo.voyd`  ⇄  `src/foo.test.voyd`
* `src/foo/bar.voyd`  ⇄  `src/foo/bar.test.voyd`
* `src/my_module.voyd` and `src/my_module/…`  ⇄  `src/my_module.test.voyd` (companion to the `my_module` root)

**Rule:** A `*.test.voyd` file MUST correspond to an existing module root. If no corresponding module exists, compilation fails with a clear error explaining the missing target module.

Rationale: keeps `*.test.voyd` semantics simple and guarantees “this file augments that module”.

### 4.3 Integration tests (`test/`)

All `.voyd` files under `test/` are compiled as integration test modules. They may contain `test` blocks.

---

## 5. The `test` Block

### 5.1 Syntax

A `test` block is a top-level declaration in a module.

Informal grammar:

```
test [modifier]* [description] :
  <body>
```

Where:

* `modifier` ∈ `{ skip, only }`
* `description` is optional (recommended)
* `<body>` is a normal block expression

Examples:

```voyd
test "unwrap_or returns value":
  let x = unwrap_or(some(3), 0)
  assert(x, eq: 3)
```

```voyd
test skip "currently broken on wasm-gc backend":
  assert(1, eq: 2)
```

```voyd
test only "focus this while debugging":
  assert(true)
```

### 5.2 Semantics

A `test` block defines a **single test case**.

* If the body completes successfully, the test **passes**.
* If the body triggers a test failure (see §8), the test **fails**.
* If the body traps/panics (unexpected runtime failure), the test **fails** with an “unhandled panic/trap” classification.

### 5.3 Naming

Each test case has a fully qualified name:

```
<module_path>::<description_or_auto_name>
```

* If a description is provided, it is used verbatim for display (and normalized internally).
* If omitted, the name is auto-generated from the source location:

  * `"<file>:<line>:<col>"` (stable within a file unless lines move)

Example:

* `std::optional::test unwrap_or returns value`
* `my_pkg::optional::<src/optional.voyd:120:1>`

### 5.4 Modifiers: `skip` and `only`

* `skip`: discovered but not executed by default. Reported as **skipped**.
* `only`: if any `only` tests exist in the run set, **only** those execute; all others are treated as skipped.

CLI flags can override skip behavior (see §9).

---

## 6. Compilation Model

### 6.1 Test builds vs normal builds

* `voyd build` (normal): ignores `test` blocks and does not include `*.test.voyd` or `test/`.
* `voyd test` (test build): includes `test` blocks, `*.test.voyd`, and `test/`.

### 6.2 Test companions “augment” modules

In test builds, `src/foo.test.voyd` is compiled as an **augmentation** of module `foo`:

* It can reference **private** items of `foo`.
* It can define private helpers used by tests.
* Declarations in `foo.test.voyd` are **test-only** and do not exist in normal builds.

**Conflicts:** If a test companion defines a symbol that conflicts with an existing module symbol, compilation fails (no shadowing).

### 6.3 Integration tests compile separately

Files under `test/` are compiled as separate modules that import the package under test as an external dependency:

* They can access only **public** items.
* They do **not** gain private access via augmentation.

---

## 7. Visibility Rules (Public vs Private)

### 7.1 Unit tests (in-source and companions)

Unit tests may access private items within the augmented module. This supports true white-box testing.

### 7.2 Integration tests

Integration tests may only access public items, same as any downstream consumer.

---

## 8. Effects Integration

Voyd tests are designed to “play nice” with effects and to encourage explicitness.

### 8.1 Boundary rule: tests must be runnable without external effect handlers

Each test case is compiled as a function whose *observable* effect row is **only** `Test` (defined by `std::test`) plus any “always-present runtime effects” (implementation-defined, e.g., panics/traps).

**Practical meaning:**

* If test code calls an effectful function (e.g., `Async -> i32`), the test must **handle** that effect internally using `try` / handlers.
* If an unhandled effect would escape the test boundary, compilation fails with an error like:

  > Test body has unhandled effect `Async`. Handle it in the test via `try` or refactor.

This gives you deterministic tests and keeps `voyd test` simple: the runner never needs to guess how to drive arbitrary effects.

### 8.2 Example: testing effectful code

Given:

```voyd
eff Async
  await(tail) -> i32
  log(resume, msg: i32) -> i32

fn worker(): Async -> i32
  let value = Async::await()
  Async::log(value)
  value + 1
```

A test must handle `Async`:

```voyd
use std::test::assertions::all

test "worker resumes and logs once":
  let result =
    try
      worker()
    Async::await(tail):
      tail(2)
    Async::log(resume, msg):
      resume(msg)

  assert(result, eq: 3)
```

### 8.3 Double-resume and “weird” behaviors

Tests can validate the semantics of effect handling (including double resume) by writing handlers explicitly, as in your examples. If the language defines double-resume behavior (allowed vs trapped vs undefined), tests should lock that down.

---

## 9. Standard Library: `std::test`

### 9.1 Modules

`std::test` provides:

* `std::test::assertions`
* `std::test::types` (optional; e.g., TestResult, TestFailure)
* `std::test::runtime` (optional; hooks used by the runner, not everyday tests)

### 9.2 The `Test` effect

Voyd’s test system uses an effect to signal structured failures without relying on raw traps.

```voyd
eff Test
  fail(msg: string) -> never
  skip(msg: string) -> never
  log(msg: string) -> ()
```

Notes:

* `fail` stops the current test case and marks it failed.
* `skip` stops the current test case and marks it skipped (useful for runtime skipping too).
* `log` emits diagnostic output associated with the current test.

The test runner provides the default handler for `Test`.

### 9.3 Minimal assertion API

`std::test::assertions` is intentionally small:

* `assert(cond: boolean, msg?: String)`
* `assert<T>(a: T, { eq b: T }, msg?: String)`
* `assert<T>(a: T, { neq b: T }, msg?: String)`
* `fail(msg: String)`
* `skip(msg: String)`
* `log(msg: String)`

#### Equality and display requirements

`assert` relies on:

* `==` / `!=` being defined for `T`, and
* a debug-string conversion for failure messages.

If either is missing, compilation fails with a clear message.

### 9.4 Failure messages

On `assert` failure, the runtime MUST report:

* expected vs actual values (using debug formatting),
* source location (file:line:col),
* the test name.

Exact formatting is reporter-dependent (see §10).

---

## 10. CLI: `voyd test`

### 10.1 Basic behavior

`voyd test`:

1. Builds the package in **test mode**
2. Discovers tests (from `test` blocks across `src/`, `src/*.test.voyd`, and `test/`)
3. Executes selected tests
4. Produces a report
5. Exits with a status code

### 10.2 Exit codes

* `0`: all executed tests passed (skips allowed)
* `1`: at least one test failed
* `2`: build/discovery error (e.g., typecheck failure, missing companion module)
* `3`: internal runner error

### 10.3 Selection and filtering

Recommended flags (exact spelling can evolve, but semantics should remain):

* `--list` : list discovered tests without running
* `--filter <substring>` : run tests whose full name contains substring
* `--exact <full_name>` : run exactly one test by full name (repeatable)
* `--include-skipped` : include `skip` tests in execution
* `--fail-fast` : stop after first failure
* `--seed <u64>` : deterministic shuffle seed
* `--order <decl|random>` : default `decl` (declaration order), `random` uses seed
* `--jobs <n>` : parallelism (default: number of cores, capped)
* `--watch` : re-run on file changes (optional but highly useful)

### 10.4 Output / reporting

* `--reporter <pretty|json|tap|pkg>` (see §11)
* `--verbose` : include logs (`Test::log`) and timings
* `--quiet` : only failures and summary

---

## 11. Execution Model

### 11.1 Isolation

By default, each test case MUST execute with:

* a fresh `Test` handler context,
* isolated log buffers.

The runtime MAY choose one of these isolation strategies:

* **Process isolation**: run each test in a separate OS process (strong isolation, slower).
* **VM/module isolation**: instantiate a fresh runtime instance per test (good default for WASM).
* **In-process isolation**: run in one process with careful reset (fastest, weakest).

The selected strategy is an implementation detail, but tests MUST NOT rely on execution order or shared global state.

### 11.2 Parallel execution

The runner MAY execute tests in parallel, subject to `--jobs`.

### 11.3 Timeouts

Optional but recommended:

* `--timeout <ms>` global per-test timeout (disabled by default or set to a conservative default)
* Timeout failure is reported as a distinct failure kind.

---

## 12. Examples

### 12.1 In-source tests next to code (small, colocated)

```voyd
use std::optional::types::all
use std::test::assertions::all

pub fn unwrap_or<T>(opt: Optional<T>, default: T) -> T
  match(opt)
    Some { value }:
      value
    None:
      default

test "unwrap_or returns inner value":
  let x = unwrap_or(some(7), 0)
  assert_eq(x, 7)

test "unwrap_or returns default for none":
  let x = unwrap_or(none(), 42)
  assert_eq(x, 42)
```

### 12.2 Larger suite in `*.test.voyd` companion (recommended for many tests)

`src/optional.voyd` contains implementation.

`src/optional.test.voyd`:

```voyd
use std::optional::types::all
use std::test::assertions::all

test "is_some(Some) is true":
  assert(is_some(some(1)))

test "is_some(None) is false":
  assert(!is_some(none()))

test "map preserves none":
  let x = map(none(), (v: i32) -> i32 => v + 1)
  assert(is_none(x))
```

Because this file augments `optional`, it can reference private helpers if needed.

### 12.3 Integration test in `test/` (black-box)

`test/optional_integration.voyd`:

```voyd
use std::test::assertions::all
use my_pkg::optional::types::all
use my_pkg::optional::unwrap_or

test "optional public api works":
  assert(unwrap_or(some(5), 0), eq: 5)
  assert(unwrap_or(none(), 9), eq: 9)
```

This test can only see `pub` exports of `my_pkg`.

---

## 13. Extensibility: Third-Party Integration (Vitest-like Ecosystems)

Voyd’s core should remain small, but the *tooling* should be extensible.

### 13.1 Reporter plugins (recommended first)

`voyd test --reporter <pkg>` loads a Node package (since the CLI is TS/Node) that implements a reporter interface.

Reporter receives structured events:

* discovery start/end
* test start
* test pass/fail/skip
* logs
* summary

This enables:

* rich UIs
* JUnit output
* IDE integrations
* dashboards

### 13.2 Stable JSON event stream (must-have)

Even without plugins, `--reporter json` MUST output a stable, versioned schema so external runners/tools can integrate without linking against internal TS APIs.

A minimal shape (illustrative):

```json
{ "schema": "voyd.test.events@1" }
{ "event": "test_started", "id": "...", "name": "...", "path": "...", "line": 12, "col": 1 }
{ "event": "test_failed", "id": "...", "message": "...", "diff": null, "duration_ms": 3 }
{ "event": "run_finished", "passed": 10, "failed": 1, "skipped": 2 }
```

### 13.3 Runner plugins (optional later)

A full runner plugin (`--runner <pkg>`) can be added later if needed for:

* custom sharding
* distributed execution
* advanced watch/HMR behavior

But start with reporter plugins + JSON events; that gets you 80% of the “Vitest ecosystem” feel without making the core brittle.

---

## 14. Future-Proofing for Doctests (Reserved Design Space)

Doctests are intentionally excluded for now, but this spec reserves a clean path:

* Add a new test source kind: `kind = "doc"`
* Discovery stage can parse doc comments and synthesize test cases
* Those cases compile into test modules in test builds (likely under an internal namespace)
* They still execute via the same `Test` effect and reporting pipeline

Because the pipeline already supports “multiple sources of test cases”, adding doctests later does not require new runtime semantics—only new discovery + codegen.

---

## 15. Style Recommendations (Non-normative)

* Use in-source `test` blocks for **small**, local invariants and regressions.
* Use `*.test.voyd` companion files once a module’s tests become sizeable.
* Use `test/` integration tests for:

  * public API contracts,
  * cross-module behavior,
  * packaging/import correctness.
