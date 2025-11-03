# ArgsForm Refactor Plan

## Background

The reader + syntax-macro pipeline currently preserves argument boundaries for calls and tuple-like constructs by inserting literal comma `IdentifierAtom`s between expressions. Those commas act as sentinels that later passes (`functional-notation` followed by `interpret-whitespace`) interpret to decide whether input represents a tuple, an explicit argument list, or a whitespace-applied call. Because the sentinel is consumed/removed as macros run, we end up with three call shapes that only remain valid within narrow windows of the pipeline:

1. **Prefix/Reader shape** – `(callee, arg1, arg2, …)` (comma separated, wrapped in forms like `["paren", ...]`).
2. **Functional-notation shape** – `[, callee, args...]` (comma token still present as the second element).
3. **Final/core shape** – `(callee arg1 arg2 …)` after whitespace interpretation.

The inability to express the final/core call shape earlier is what forces fragile, stateful handling in reader macros (`prefixCall` helpers), syntax macros, and helper utilities such as `interpretWhitespace`.

## Goals

- Introduce a first-class `ArgsForm` node that carries explicit vs implicit separation metadata, so stages can reason about argument boundaries without relying on comma sentinels.
- Normalize all call-like forms (functional notation, tuples, reader-macro output) so they consistently use `(callee ArgsForm)` regardless of when they are produced.
- Update whitespace interpretation to consume and produce `ArgsForm` instances instead of relying on comma tokens, enabling the whitespace-only call form to be emitted at any pipeline stage.
- Maintain existing parser behaviour at the end of the pipeline (the AST returned by `parse` and its tests should remain unchanged).
- Update `src/next/parser/__tests__/reader.test.ts` (and only this test) if a new raw reader shape is introduced.

## Non-Goals

- No changes to semantics outside of argument handling (e.g., no new language features).
- No updates to code generation or downstream stages beyond what is required to consume the revised AST shape.

## Constraints

- All existing tests must pass unchanged, apart from `reader.test.ts` which may need updates to reflect the new raw AST representation.
- Maintain the functional programming + flat structure guidelines outlined in `reference/syntax.md`.
- Preserve source locations on newly introduced `ArgsForm` nodes.
- Keep helper utilities general; `ArgsForm` should not encode language-level constructs (tuples, etc.)—only argument separation metadata.

## Implementation Steps

1. **Define the ArgsForm Node**
   - Add `ArgsForm` (subclassing `Form`) under `src/next/parser/ast/args-form.ts`.
   - Include metadata `separation: "explicit" | "implicit"` (extensible in future).
   - Provide constructors/helpers (`ArgsForm.explicit`, `ArgsForm.implicit`, `ArgsForm.fromForm`, `append`, `clone`, `toArgsArray`).
   - Export via `src/next/parser/ast/index.ts`.

2. **Update Call Helper Layer**
   - Refactor `src/next/parser/reader-macros/lib/init-helpers.ts` to build `ArgsForm` rather than comma-sentinel structures.
   - Ensure helpers (`call`, `prefixCall`, `prefixTuple`, `prefixArrayLiteral`, etc.) clearly distinguish when arguments are explicit (delimited) versus implicit (ellipsis/whitespace driven).
   - Normalise helper input (strings, nested arrays) into `Expr`s without reintroducing commas.

3. **Reader Macro Adjustments**
   - Update all reader macros that currently rely on commas (`paren`, `arrayLiteral`, `mapLiteral`, `generics`, `objectLiteral`, HTML parser, etc.) to use the new helper output.
   - Confirm `reader.test.ts` snapshots/expectations match the new raw AST shape (`ArgsForm` instances will appear instead of comma sequences). Adjust only this test as permitted.

4. **Functional Notation Normalisation**
   - Adapt `functional-notation.ts` to:
     - Accept/emit `(callee ArgsForm)` directly.
     - Handle nested `ArgsForm` instances (e.g., generics + params).
     - Replace tuple detection logic (which currently sets `isTuple` when commas appear) with metadata on the resulting `ArgsForm` (e.g., `ArgsForm.explicit` to indicate delimiters).
   - Ensure recursion continues to normalise child forms.

5. **Introduce a Dedicated Normalisation Pass**
   - Add a new syntax macro (e.g., `normalize-args.ts`) inserted between `functionalNotation` and `interpretWhitespace`:
     - Convert any legacy comma-based forms still produced (from existing macros or edge cases) into `(callee ArgsForm)` structures.
     - Recursively process nested forms.
     - Strip redundant comma sentinel nodes.
   - This pass should be idempotent (re-running should not alter the AST).

6. **Rewrite Whitespace Interpretation**
   - Refactor `interpret-whitespace.ts` to:
     - Operate on `ArgsForm` for argument aggregation.
     - Use `ArgsForm.separation` to track explicit vs implicit arguments (`explicit` whenever a comma-delimited argument or reader-provided tuple is encountered; `implicit` for whitespace-derived arguments).
     - Remove dependence on the `hadComma` flag and literal comma lookahead.
     - Ensure block insertion (`block` nodes) and named argument handling still function; update helper utilities accordingly.

7. **Downstream Adjustments**
   - Audit other syntax macros (`primary.ts`, `functional-notation.ts`, etc.) for any direct comma checks and adapt them to recognise `ArgsForm`.
   - Update any utility functions that previously assumed the second slot of a `Form` was a `Form` representing argument lists.

8. **Testing & Validation**
   - Update `src/next/parser/__tests__/reader.test.ts` snapshot/expectation to reflect the new raw AST shape.
   - Run `npm test` (or `vitest run`) to ensure parser/semantics/codegen snapshots remain unchanged.
   - Optionally add focused unit tests:
     - A new test asserting `ArgsForm` normalisation for nested generics.
     - Tests verifying `interpretWhitespace` handles explicit/implicit mixing (e.g., `call(a, b)\n  c` vs `call a\n  b`).

9. **Documentation & Cleanup**
   - Update `reference/syntax.md` (if necessary) to explain the new internal representation (optional but helpful).
   - Remove any deprecated helpers or dead code (e.g., comma splitting utilities) once the new pipeline is stabilised.

## Risks & Mitigations

- **Risk:** Missing a macro that still emits the old comma shape.
  - **Mitigation:** Add assertions/logging during development or write unit tests targeting each reader macro output.
- **Risk:** Location propagation bugs when wrapping/unwrapping arguments.
  - **Mitigation:** Ensure `ArgsForm` constructors clone locations; add tests for location spans if regressions appear.
- **Risk:** Downstream code relying on raw array indexing into `Form` elements.
  - **Mitigation:** Search for `.at(1)` usage on call forms and update to handle `ArgsForm` explicitly.

## Testing Checklist

- [ ] Update `reader.test.ts` expectations.
- [ ] Run `npm test` after each major milestone (helper refactor, syntax macro changes, whitespace rewrite).
- [ ] Manually parse representative samples (`vt --emit-parser-ast`, or `parse` fixtures) to sanity-check ASTs during the refactor.

