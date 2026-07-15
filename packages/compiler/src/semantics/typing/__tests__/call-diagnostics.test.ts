import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";
import { parse } from "../../../parser/parser.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

describe("call diagnostics", () => {
  it("does not infer omitted lambda parameters from its own call arguments", () => {
    const ast = parse(
      `
pub fn main() -> i32
  (() => 1)(42)
`,
      "/proj/src/immediate-lambda.voyd"
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0005");
    expect(caught.diagnostic.message).toMatch(/cannot call a non-function/i);
  });

  it("reports diagnostics for calling non-function values", () => {
    const ast = loadAst("non_function_call.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0005");
    expect(caught.diagnostic.message).toMatch(
      /cannot call a non-function value/i
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "non_function_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("x");
  });

  it("reports diagnostics for calling a missing function", () => {
    const ast = loadAst("missing_function_call.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0006");
    expect(caught.diagnostic.message).toMatch(/function 'hi' is not defined/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "missing_function_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("hi");
  });

  it("reports diagnostics for calling a missing method", () => {
    const ast = loadAst("missing_method_call.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0022");
    expect(caught.diagnostic.message).toMatch(
      /method 'nope' is not defined on Box/i
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "missing_method_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("b.nope");
  });

  it("reports diagnostics with spans for call argument type mismatches", () => {
    const ast = loadAst("call_arg_type_mismatch.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "call_arg_type_mismatch.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("true");
  });

  it("diagnoses labeled constructor calls when only an unlabeled init exists", () => {
    const ast = loadAst("constructor_call_labeled_requires_labeled_init.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0021");
    expect(caught.diagnostic.message).toMatch(/label mismatch/i);
    expect(caught.diagnostic.message).toMatch(/expected no label, got major/i);
  });

  it("diagnoses unlabeled constructor calls when only a labeled init exists", () => {
    const ast = loadAst("constructor_call_unlabeled_requires_unlabeled_init.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0021");
    expect(caught.diagnostic.message).toMatch(/label mismatch/i);
    expect(caught.diagnostic.message).toMatch(/expected major, got no label/i);
  });

  it("constructs nominal fields when a type has no explicit init", () => {
    const ast = loadAst("constructor_call_without_init.voyd");
    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("supports fieldwise calls for empty, optional, value, generic, and alias targets", () => {
    const ast = parse(
      `
obj Empty {}
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None
obj OptionalBox { value?: i32 }
val Point { x: i32, y: i32 }
obj Box<T> { value: T }
type BoxAlias<T> = Box<T>
obj Animal { id: i32 }
obj Dog: Animal { id: i32 }
obj AnimalBox<T: Animal> { value: T }
type AnimalBoxAlias<T: Animal> = AnimalBox<T>

pub fn main() -> i32
  let _empty = Empty()
  let _optional = OptionalBox()
  let point = Point(y: 2, x: 1)
  let box = Box(value: 3)
  let alias = BoxAlias(value: 4)
  let constrained = AnimalBoxAlias(value: Dog(id: 5))
  point.x + point.y + box.value + alias.value + constrained.value.id
`,
      "/proj/src/fieldwise-calls.voyd",
    );

    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);
    expect(
      Array.from(result.hir.expressions.values()).filter(
        (expr) => expr.exprKind === "object-literal" && expr.literalKind === "nominal",
      ),
    ).toHaveLength(7);
  });

  it("reports missing fields for fieldwise calls", () => {
    const ast = parse(
      `
obj Person { age: i32 }

pub fn main() -> i32
  let _person = Person()
  0
`,
      "/proj/src/fieldwise-call-missing-field.voyd",
    );

    expect(() => semanticsPipeline(ast)).toThrow(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: "TY0037" }) }),
    );
  });

  it("rejects excess explicit type arguments on fieldwise aliases", () => {
    const ast = parse(
      `
obj Box<T> { value: T }
type BoxAlias<T> = Box<T>

pub fn main() -> i32
  let _box = BoxAlias<i32, bool>(value: 1)
  0
`,
      "/proj/src/fieldwise-alias-extra-type-argument.voyd",
    );

    expect(() => semanticsPipeline(ast)).toThrow(/argument count mismatch/i);
  });

  it("rejects excess explicit type arguments on direct fieldwise calls", () => {
    const ast = parse(
      `
obj Box<T> { value: T }

pub fn main() -> i32
  let _box = Box<i32, bool>(value: 1)
  0
`,
      "/proj/src/fieldwise-extra-type-argument.voyd",
    );

    expect(() => semanticsPipeline(ast)).toThrow(/argument count mismatch/i);
  });

  it("keeps brace construction compatible with union member type arguments", () => {
    const ast = parse(
      `
obj Some<T> { value: T }
obj None {}
type Option<T> = Some<T> | None

pub fn main() -> i32
  let _value: Option<i32> = None<i32> {}
  0
`,
      "/proj/src/brace-union-member-type-argument.voyd",
    );

    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("rejects uninferable generic alias arguments in fieldwise calls", () => {
    const ast = parse(
      `
obj Box<T> { value: T }
type Alias<T, U> = Box<T>

pub fn main() -> i32
  let box = Alias(value: 1)
  box.value
`,
      "/proj/src/fieldwise-alias-unresolved-type-argument.voyd",
    );

    expect(() => semanticsPipeline(ast)).toThrow(/missing 1 type argument/i);
  });

  it("infers zero-field generic construction from the expected union type", () => {
    const ast = parse(
      `
obj Ready<T> {}
obj Other {}
type Signal<T> = Ready<T> | Other

pub fn main() -> i32
  let _signal: Signal<i32> = Ready()
  0
`,
      "/proj/src/fieldwise-call-expected-type.voyd",
    );

    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("infers generic constructor type arguments for zero-arg calls from expected types", () => {
    const semantics = semanticsPipeline(
      loadAst("constructor_call_zero_arg_generic_infers_expected_type.voyd"),
    );
    expect(semantics.diagnostics).toHaveLength(0);

    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const inferredCall = Array.from(typing.callTypeArguments.entries()).find(
      ([callId, typeArgsByInstance]) => {
        const expr = hir.expressions.get(callId);
        if (!expr || expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        if (!callee || callee.exprKind !== "identifier") {
          return false;
        }
        if (symbolTable.getSymbol(callee.symbol).name !== "init") {
          return false;
        }
        const typeArgs = Array.from(typeArgsByInstance.values())[0];
        if (!typeArgs || typeArgs.length !== 1) {
          return false;
        }
        const typeArg = typing.arena.get(typeArgs[0]!);
        return typeArg.kind === "primitive" && typeArg.name === "i32";
      },
    );

    expect(inferredCall).toBeDefined();
  });

  it("reports that unresolved generic constructor calls need explicit type arguments", () => {
    expect(() =>
      semanticsPipeline(loadAst("constructor_call_generic_missing_type_args.voyd")),
    ).toThrow(/add explicit type arguments/i);
  });

  it("enforces fixed type arguments when calling constructors through aliases", () => {
    const ast = loadAst("constructor_call_alias_fixed_type_args_enforced.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/i,
    );
  });

  it("enforces fixed type arguments for alias ::init constructor calls", () => {
    const ast = loadAst("constructor_call_alias_fixed_type_args_static_init_enforced.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/i,
    );
  });

  it("enforces fixed type arguments across alias-to-alias constructor calls", () => {
    const ast = loadAst("constructor_call_alias_chain_fixed_type_args_enforced.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/i,
    );
  });

  it("enforces fixed type arguments when alias ::init is referenced then called", () => {
    const ast = loadAst("constructor_call_alias_static_init_ref_enforced.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/i,
    );
  });

  it("enforces namespace type arguments when alias ::init is referenced then called", () => {
    const ast = loadAst(
      "constructor_call_alias_static_init_ref_with_explicit_type_args_enforced.voyd",
    );

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0027");
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/i,
    );
  });

  it("allows type inference when generic alias ::init is referenced then called", () => {
    const ast = loadAst("constructor_call_alias_static_init_ref_infers_type_args.voyd");
    const result = semanticsPipeline(ast);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("rejects extra namespace type arguments on alias ::init references", () => {
    const ast = loadAst(
      "constructor_call_alias_static_init_ref_rejects_extra_namespace_type_args.voyd",
    );
    expect(() => semanticsPipeline(ast)).toThrow(
      /too many type arguments|argument count mismatch/i,
    );
  });

  it("rejects extra type arguments for concrete alias constructor calls", () => {
    const ast = loadAst("constructor_call_alias_rejects_extra_type_args.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(
      /too many type arguments|type mismatch/i,
    );
  });

  it("rejects extra type arguments for generic alias constructor calls", () => {
    const ast = loadAst(
      "constructor_call_alias_generic_rejects_extra_type_args.voyd",
    );
    expect(() => semanticsPipeline(ast)).toThrow(/too many type arguments/i);
  });

  it("does not treat aliases to type parameters as constructor values", () => {
    const ast = loadAst("constructor_call_alias_type_parameter_shadowing.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0041");
    expect(caught.diagnostic.message).toMatch(/is a type, not a value/i);
  });
});
