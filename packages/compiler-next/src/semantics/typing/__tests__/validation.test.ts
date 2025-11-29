import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createHirBuilder } from "../../hir/index.js";
import type { HirPattern, HirTypeExpr } from "../../hir/index.js";
import type { NodeId, SourceSpan } from "../../ids.js";
import { DeclTable } from "../../decls.js";
import { runTypingPipeline } from "../typing.js";

const span: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createNodeGenerator = (): (() => NodeId) => {
  let next: NodeId = 1;
  return () => next++;
};

describe("typing validation invariants", () => {
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

    const paramPattern: HirPattern = { kind: "identifier", symbol: paramSymbol };
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
      visibility: "module",
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
      })
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
      visibility: "module",
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

    const paramPattern: HirPattern = { kind: "identifier", symbol: paramSymbol };
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
      visibility: "module",
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
      })
    ).toThrow(/missing 1 type argument/);
  });
});
