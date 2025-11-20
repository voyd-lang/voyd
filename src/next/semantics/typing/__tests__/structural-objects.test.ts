import { describe, expect, it } from "vitest";
import { runTypingPipeline } from "../pipeline.js";
import type { HirObjectTypeExpr, HirNamedTypeExpr } from "../../hir/nodes.js";
import { createModuleContext } from "./helpers.js";
import type { ScopeId } from "../../ids.js";
import { Expr } from "src/next/parser/index.js";

const createNamedType = (
  name: string,
  ast: number,
  span: HirNamedTypeExpr["span"]
): HirNamedTypeExpr => ({
  typeKind: "named",
  path: [name],
  ast,
  span,
});

describe("structural objects", () => {
  it("types object literals, spreads, and field accesses", () => {
    const ctx = createModuleContext();
    const fakeExpr = (): Expr =>
      ({ syntaxId: ctx.nextNode(), location: ctx.span } as unknown as Expr);
    const functionScope = ctx.symbolTable.rootScope as ScopeId;
    const addSymbol = ctx.symbolTable.declare({
      name: "add",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const vecSymbol = ctx.symbolTable.declare({
      name: "vec",
      kind: "parameter",
      declaredAt: ctx.nextNode(),
    });
    const mainSymbol = ctx.symbolTable.declare({
      name: "main",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const myVecSymbol = ctx.symbolTable.declare({
      name: "my_vec",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const cloneSymbol = ctx.symbolTable.declare({
      name: "clone",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const aliasSymbol = ctx.symbolTable.declare({
      name: "MyVec",
      kind: "type",
      declaredAt: ctx.nextNode(),
    });

    const aliasTarget: HirObjectTypeExpr = {
      typeKind: "object",
      fields: [
        {
          name: "x",
          type: createNamedType("i32", ctx.nextNode(), ctx.span),
          span: ctx.span,
        },
        {
          name: "y",
          type: createNamedType("i32", ctx.nextNode(), ctx.span),
          span: ctx.span,
        },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    };
    const aliasDecl = ctx.decls.registerTypeAlias({
      name: "MyVec",
      visibility: "module",
      symbol: aliasSymbol,
      form: undefined,
      target: aliasTarget as unknown as Expr,
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addItem({
      kind: "type-alias",
      visibility: "module",
      decl: aliasDecl.id,
      symbol: aliasSymbol,
      target: aliasTarget,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const parameterType: HirNamedTypeExpr = {
      typeKind: "named",
      path: ["MyVec"],
      ast: ctx.nextNode(),
      span: ctx.span,
    };

    const vecIdentifier = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "identifier",
      symbol: vecSymbol,
      ast: ctx.nextNode(),
      span: ctx.span,
    });
    const vecFieldAccess = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "field-access",
      target: vecIdentifier,
      field: "x",
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const addDecl = ctx.decls.registerFunction({
      name: "add",
      visibility: "module",
      symbol: addSymbol,
      scope: functionScope,
      params: [{ name: "vec", symbol: vecSymbol, ast: undefined }],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: "module",
      symbol: addSymbol,
      decl: addDecl.id,
      parameters: [
        {
          symbol: vecSymbol,
          pattern: { kind: "identifier", symbol: vecSymbol },
          mutable: false,
          span: ctx.span,
          type: parameterType,
        },
      ],
      returnType: createNamedType("i32", ctx.nextNode(), ctx.span),
      body: ctx.createBlock([], vecFieldAccess),
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const literal = (value: string) => ctx.createLiteral("i32", value);
    const baseObject = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "object-literal",
      literalKind: "structural",
      entries: [
        { kind: "field", name: "x", value: literal("1"), span: ctx.span },
        { kind: "field", name: "y", value: literal("2"), span: ctx.span },
        { kind: "field", name: "z", value: literal("3"), span: ctx.span },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const myVecStmt = ctx.builder.addStatement({
      kind: "let",
      mutable: false,
      pattern: { kind: "identifier", symbol: myVecSymbol },
      initializer: baseObject,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const cloneLiteral = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "object-literal",
      literalKind: "structural",
      entries: [
        {
          kind: "spread",
          value: ctx.builder.addExpression({
            kind: "expr",
            exprKind: "identifier",
            symbol: myVecSymbol,
            ast: ctx.nextNode(),
            span: ctx.span,
          }),
          span: ctx.span,
        },
        { kind: "field", name: "extra", value: literal("10"), span: ctx.span },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const cloneStmt = ctx.builder.addStatement({
      kind: "let",
      mutable: false,
      pattern: { kind: "identifier", symbol: cloneSymbol },
      initializer: cloneLiteral,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const callExpr = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "call",
      callee: ctx.builder.addExpression({
        kind: "expr",
        exprKind: "identifier",
        symbol: addSymbol,
        ast: ctx.nextNode(),
        span: ctx.span,
      }),
      args: [
        {
          expr: ctx.builder.addExpression({
            kind: "expr",
            exprKind: "identifier",
            symbol: cloneSymbol,
            ast: ctx.nextNode(),
            span: ctx.span,
          }),
        },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const mainBody = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "block",
      statements: [myVecStmt, cloneStmt],
      value: callExpr,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const mainDecl = ctx.decls.registerFunction({
      name: "main",
      visibility: "public",
      symbol: mainSymbol,
      scope: functionScope,
      params: [],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: "public",
      symbol: mainSymbol,
      decl: mainDecl.id,
      parameters: [],
      returnType: createNamedType("i32", ctx.nextNode(), ctx.span),
      body: mainBody,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir: ctx.builder.finalize(),
      overloads: new Map(),
      decls: ctx.decls,
    });

    const vecType = typing.valueTypes.get(vecSymbol);
    expect(vecType).toBeDefined();
    const vecDesc = typing.arena.get(vecType!);
    expect(vecDesc.kind).toBe("structural-object");
    if (vecDesc.kind !== "structural-object") {
      throw new Error("expected structural object type for parameter");
    }

    const cloneType = typing.valueTypes.get(cloneSymbol);
    expect(cloneType).toBeDefined();
    const cloneDesc = typing.arena.get(cloneType!);
    expect(cloneDesc.kind).toBe("structural-object");
    if (cloneDesc.kind !== "structural-object") {
      throw new Error("expected structural object type");
    }
    const fieldNames = cloneDesc.fields.map((field) => field.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(["x", "y", "z", "extra"])
    );

    const fieldAccessType = typing.table.getExprType(vecFieldAccess);
    expect(fieldAccessType).toBeDefined();
    const fieldAccessDesc = typing.arena.get(fieldAccessType!);
    expect(fieldAccessDesc).toMatchObject({ kind: "primitive", name: "i32" });

    const callType = typing.table.getExprType(callExpr);
    expect(callType).toBeDefined();
    const callDesc = typing.arena.get(callType!);
    expect(callDesc).toMatchObject({ kind: "primitive", name: "i32" });
  });
});
