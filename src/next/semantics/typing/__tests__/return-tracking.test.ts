import { describe, expect, it } from "vitest";
import { createSymbolTable } from "../../binder/index.js";
import { createHirBuilder } from "../../hir/index.js";
import { runTypingPipeline } from "../pipeline.js";
import type {
  HirExprId,
  HirStmtId,
  NodeId,
  SourceSpan,
  SymbolId,
} from "../../ids.js";
import type { HirLiteralExpr, HirNamedTypeExpr } from "../../hir/nodes.js";

const createSpan = (): SourceSpan => ({ file: "test.voyd", start: 0, end: 0 });

const createModuleContext = () => {
  let nextNodeId: NodeId = 1;
  const nextNode = (): NodeId => nextNodeId++;
  const span = createSpan();
  const symbolTable = createSymbolTable({ rootOwner: 0 });
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

  const createLiteral = (
    literalKind: HirLiteralExpr["literalKind"],
    value: string
  ): HirExprId =>
    builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      literalKind,
      value,
      ast: nextNode(),
      span,
    });

  const createReturn = (value?: HirExprId): HirStmtId =>
    builder.addStatement({
      kind: "return",
      value,
      ast: nextNode(),
      span,
    });

  const createBlock = (
    statements: readonly HirStmtId[],
    value?: HirExprId
  ): HirExprId =>
    builder.addExpression({
      kind: "expr",
      exprKind: "block",
      statements,
      value,
      ast: nextNode(),
      span,
    });

  const addFunction = (
    symbol: SymbolId,
    body: HirExprId,
    returnType?: HirNamedTypeExpr
  ) =>
    builder.addFunction({
      kind: "function",
      visibility: "module",
      symbol,
      parameters: [],
      returnType,
      body,
      ast: nextNode(),
      span,
    });

  return {
    symbolTable,
    builder,
    span,
    nextNode,
    createLiteral,
    createReturn,
    createBlock,
    addFunction,
  };
};

describe("return tracking", () => {
  it("allows return statements inside typed functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "withReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const valueExpr = ctx.createLiteral("i32", "42");
    const body = ctx.createBlock([ctx.createReturn(valueExpr)], valueExpr);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["i32"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir,
    });

    const scheme = typing.table.getSymbolScheme(fnSymbol);
    expect(scheme).toBeDefined();
    const instantiated = typing.arena.instantiate(scheme!, []);
    const fnType = typing.arena.get(instantiated);
    expect(fnType).toMatchObject({ kind: "function" });
    if (fnType.kind !== "function") {
      throw new Error("expected function type");
    }
    const returnTypeDesc = typing.arena.get(fnType.returnType);
    expect(returnTypeDesc).toMatchObject({ kind: "primitive", name: "i32" });
  });

  it("permits empty return statements in void functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "voidReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const body = ctx.createBlock([ctx.createReturn()]);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["void"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir,
    });

    const scheme = typing.table.getSymbolScheme(fnSymbol);
    expect(scheme).toBeDefined();
    const instantiated = typing.arena.instantiate(scheme!, []);
    const fnType = typing.arena.get(instantiated);
    expect(fnType).toMatchObject({ kind: "function" });
    if (fnType.kind !== "function") {
      throw new Error("expected function type");
    }
    const returnTypeDesc = typing.arena.get(fnType.returnType);
    expect(returnTypeDesc).toMatchObject({ kind: "primitive", name: "voyd" });
  });

  it("rejects missing return values for non-void functions", () => {
    const ctx = createModuleContext();
    const fnSymbol = ctx.symbolTable.declare({
      name: "missingReturn",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const trailingExpr = ctx.createLiteral("i32", "1");
    const body = ctx.createBlock([ctx.createReturn()], trailingExpr);
    ctx.addFunction(fnSymbol, body, {
      typeKind: "named",
      path: ["i32"],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const hir = ctx.builder.finalize();
    expect(() =>
      runTypingPipeline({
        symbolTable: ctx.symbolTable,
        hir,
      })
    ).toThrow(/return statement/);
  });
});
