import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createHirBuilder, moduleVisibility } from "../../hir/index.js";
import type { HirPattern, HirTypeExpr } from "../../hir/index.js";
import type { NodeId, SourceSpan } from "../../ids.js";
import { DeclTable } from "../../decls.js";
import { runTypingPipeline } from "../typing.js";
import { parse } from "../../../parser/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

const span: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createNodeGenerator = (): (() => NodeId) => {
  let next: NodeId = 1;
  return () => next++;
};

describe("typing validation invariants", () => {
  const compileSource = (source: string) =>
    semanticsPipeline(parse(source, "borrow-validation.voyd"));

  const compileDiagnostic = (source: string): DiagnosticError => {
    try {
      compileSource(source);
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticError);
      if (error instanceof DiagnosticError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected compilation to report a diagnostic");
  };

  it("accepts Borrow only as direct callable input types", () => {
    expect(() =>
      compileSource(`
fn inspect(value: Borrow<i32>) -> i32
  1

fn store(body: fn(value: Borrow<i32>) : () -> i32) -> i32
  1
`),
    ).not.toThrow();
  });

  it.each([
    {
      name: "plain value",
      initializer: "value",
      parameter: "value: Box",
    },
    {
      name: "temporary",
      initializer: "Box { value: 1 }",
      parameter: "value: i32",
    },
  ])(
    "rejects forming a local Borrow from a $name",
    ({ initializer, parameter }) => {
      const error = compileDiagnostic(`
obj Box { value: i32 }

fn bad(${parameter}) -> i32
  let alias: Borrow<Box> = ${initializer}
  alias.value
`);

      expect(error.diagnostic.code).toBe("TY0027");
      expect(error.diagnostic.message).toMatch(/expected 'Borrow<object Box/);
    },
  );

  it("allows a local Borrow alias of an active Borrow parameter", () => {
    expect(() =>
      compileSource(`
obj Box { value: i32 }

fn inspect(value: Borrow<Box>) -> i32
  let alias: Borrow<Box> = value
  alias.value
`),
    ).not.toThrow();
  });

  it.each([
    {
      actual: "i32",
      expected: "i32 | bool",
    },
    {
      actual: "i32 | bool",
      expected: "i32",
    },
  ])(
    "keeps Borrow<$actual> invariant from Borrow<$expected>",
    ({ actual, expected }) => {
      expect(() =>
        compileSource(`
fn consume(value: Borrow<${expected}>) -> i32
  1

fn invalid(value: Borrow<${actual}>) -> i32
  consume(value)
`),
      ).toThrow();
    },
  );

  it("allows a local Borrow alias of an active Borrow projection", () => {
    expect(() =>
      compileSource(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

fn inspect(value: Borrow<Wrapper>) -> i32
  let inner: Borrow<Box> = value.inner
  inner.value
`),
    ).not.toThrow();
  });

  it("rejects a local Borrow alias of an ordinary projection", () => {
    const error = compileDiagnostic(`
obj Box { value: i32 }
obj Wrapper { inner: Box }

fn bad(value: Wrapper) -> i32
  let inner: Borrow<Box> = value.inner
  inner.value
`);

    expect(error.diagnostic.code).toBe("TY0027");
    expect(error.diagnostic.message).toMatch(/expected 'Borrow<object Box/);
  });

  it("validates normalized lambda Borrow positions", () => {
    const returnError = compileDiagnostic(`
obj Box { value: i32 }

fn main() -> i32
  let callback = (value: Box) -> Borrow<Box> => value
  0
`);
    expect(returnError.diagnostic.code).toBe("TY0051");
    expect(returnError.diagnostic.message).toMatch(
      /complete callable parameter type.*lambda signature nested callable return type/,
    );

    const nestedParameterError = compileDiagnostic(`
obj Box { value: i32 }
type Loan = Borrow<Box>

fn main() -> i32
  let callback = (value: (Loan, i32)) => 0
  0
`);
    expect(nestedParameterError.diagnostic.code).toBe("TY0051");
    expect(nestedParameterError.diagnostic.message).toMatch(
      /complete callable parameter type.*nested callable parameter 1 field/,
    );
  });

  it("validates inferred effects on lambdas with Borrow parameters", () => {
    const error = compileDiagnostic(`
eff Tick
  fn get(tail) -> i32

fn main() -> i32
  let callback = ((value: Borrow<i32>) : Tick -> i32) => Tick::get() + value
  0
`);

    expect(error.diagnostic.code).toBe("TY0051");
    expect(error.diagnostic.message).toMatch(
      /must have an empty effect row.*lambda signature/,
    );
  });

  it("allows pure Borrow-aware lambdas as ordinary function values", () => {
    expect(() =>
      compileSource(`
obj Box { value: i32 }

fn main() -> i32
  let callback = (value: Borrow<Box>) => value.value
  callback(Box { value: 1 })
`),
    ).not.toThrow();
  });

  it.each([
    {
      name: "result",
      source: `fn leak(value: i32) -> Borrow<i32>\n  value`,
    },
    {
      name: "aggregate member",
      source: `fn bad(value: (Borrow<i32>, i32)) -> i32\n  1`,
    },
    {
      name: "nested borrow",
      source: `fn bad(value: Borrow<Borrow<i32>>) -> i32\n  1`,
    },
    {
      name: "object field",
      source: `obj Bad { value: Borrow<i32> }\nfn main() -> i32\n  1`,
    },
  ])("rejects Borrow in a $name", ({ source }) => {
    const error = compileDiagnostic(source);
    expect(error.diagnostic.code).toBe("TY0051");
    expect(error.diagnostic.message).toMatch(/Borrow/);
  });

  it("does not allow a borrowed value to instantiate an ordinary generic", () => {
    expect(() =>
      compileSource(`
fn identity<T>(value: T) -> T
  value

fn bad(value: Borrow<i32>) -> i32
  identity(value)
`),
    ).toThrow(/cannot instantiate ordinary type parameter/);
  });

  it("rejects ordinary methods on borrowed receivers", () => {
    expect(() =>
      compileSource(`
obj Box { value: i32 }

impl Box
  fn read(self) -> i32
    self.value

fn bad(value: Borrow<Box>) -> i32
  value.read()
`),
    ).toThrow(/ordinary method receivers/);
  });

  it("rejects effects in a callable with a Borrow parameter", () => {
    const error = compileDiagnostic(`
eff Async
  fn await(tail) -> i32

fn bad(value: Borrow<i32>) -> i32
  Async::await()
`);
    expect(error.diagnostic.code).toBe("TY0051");
    expect(error.diagnostic.message).toMatch(/empty effect row/);
  });

  it("rejects Borrow at effect and external boundaries", () => {
    const effectError = compileDiagnostic(`
eff Invalid
  fn read(tail, value: Borrow<i32>) -> i32
`);
    expect(effectError.diagnostic.code).toBe("TY0051");
    expect(effectError.diagnostic.message).toMatch(
      /effect operation signature/,
    );

    const externalError = compileDiagnostic(`
@external(id: "example:test/borrow@1")
fn read(value: Borrow<i32>) -> i32
  1
`);
    expect(externalError.diagnostic.code).toBe("TY0051");
    expect(externalError.diagnostic.message).toMatch(
      /external function signature/,
    );
  });

  it("rejects Borrow type declarations and invalid arity", () => {
    expect(() => compileSource("type Borrow = i32")).toThrow(
      /reserved identifier Borrow/,
    );
    expect(() =>
      compileSource("fn bad(value: Borrow<i32, bool>) -> i32\n  1"),
    ).toThrow(/exactly one type argument/);
  });

  it("rejects unknown parameter types that survive strict typing", () => {
    const nextNode = createNodeGenerator();
    const symbolTable = new SymbolTable({ rootOwner: 0 });
    const moduleSymbol = symbolTable.declare({
      name: "test",
      kind: "module",
      declaredAt: nextNode(),
    });
    const builder = createHirBuilder({
      path: span.file,
      scope: moduleSymbol,
      ast: 0,
      span,
    });

    const paramSymbol = symbolTable.declare({
      name: "payload",
      kind: "value",
      declaredAt: nextNode(),
    });
    const fnSymbol = symbolTable.declare({
      name: "usesUnknown",
      kind: "value",
      declaredAt: nextNode(),
    });

    const paramPattern: HirPattern = {
      kind: "identifier",
      symbol: paramSymbol,
    };
    const literal = builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      literalKind: "i32",
      value: "0",
      ast: nextNode(),
      span,
    });
    const body = builder.addExpression({
      kind: "expr",
      exprKind: "block",
      statements: [],
      value: literal,
      ast: nextNode(),
      span,
    });

    const returnType: HirTypeExpr = {
      typeKind: "named",
      path: ["i32"],
      ast: nextNode(),
      span,
    };

    builder.addFunction({
      kind: "function",
      visibility: moduleVisibility(),
      symbol: fnSymbol,
      parameters: [
        {
          symbol: paramSymbol,
          pattern: paramPattern,
          span,
          mutable: false,
        },
      ],
      returnType,
      body,
      ast: nextNode(),
      span,
    });

    const hir = builder.finalize();
    expect(() =>
      runTypingPipeline({
        symbolTable,
        hir,
        overloads: new Map(),
        decls: new DeclTable(),
      }),
    ).toThrow(/unknown type/i);
  });

  it("fails fast when type alias arguments are missing", () => {
    const nextNode = createNodeGenerator();
    const symbolTable = new SymbolTable({ rootOwner: 0 });
    const moduleSymbol = symbolTable.declare({
      name: "test",
      kind: "module",
      declaredAt: nextNode(),
    });
    const builder = createHirBuilder({
      path: span.file,
      scope: moduleSymbol,
      ast: 0,
      span,
    });

    const typeParamSymbol = symbolTable.declare({
      name: "T",
      kind: "type",
      declaredAt: nextNode(),
    });
    const aliasSymbol = symbolTable.declare({
      name: "Wrap",
      kind: "type",
      declaredAt: nextNode(),
    });
    const aliasTarget: HirTypeExpr = {
      typeKind: "named",
      path: ["T"],
      symbol: typeParamSymbol,
      ast: nextNode(),
      span,
    };
    builder.addItem({
      kind: "type-alias",
      visibility: moduleVisibility(),
      symbol: aliasSymbol,
      typeParameters: [{ symbol: typeParamSymbol, span }],
      target: aliasTarget,
      ast: nextNode(),
      span,
    });

    const paramSymbol = symbolTable.declare({
      name: "wrapped",
      kind: "value",
      declaredAt: nextNode(),
    });
    const fnSymbol = symbolTable.declare({
      name: "consumeWrap",
      kind: "value",
      declaredAt: nextNode(),
    });

    const paramPattern: HirPattern = {
      kind: "identifier",
      symbol: paramSymbol,
    };
    const paramType: HirTypeExpr = {
      typeKind: "named",
      path: ["Wrap"],
      symbol: aliasSymbol,
      ast: nextNode(),
      span,
    };
    const literal = builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      literalKind: "i32",
      value: "1",
      ast: nextNode(),
      span,
    });
    const body = builder.addExpression({
      kind: "expr",
      exprKind: "block",
      statements: [],
      value: literal,
      ast: nextNode(),
      span,
    });

    builder.addFunction({
      kind: "function",
      visibility: moduleVisibility(),
      symbol: fnSymbol,
      parameters: [
        {
          symbol: paramSymbol,
          pattern: paramPattern,
          span,
          mutable: false,
          type: paramType,
        },
      ],
      returnType: {
        typeKind: "named",
        path: ["i32"],
        ast: nextNode(),
        span,
      },
      body,
      ast: nextNode(),
      span,
    });

    const hir = builder.finalize();
    expect(() =>
      runTypingPipeline({
        symbolTable,
        hir,
        overloads: new Map(),
        decls: new DeclTable(),
      }),
    ).toThrow(/missing 1 type argument/);
  });
});
