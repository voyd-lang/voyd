import { describe, expect, it } from "vitest";
import { runTypingPipeline } from "../typing.js";
import type { HirNamedTypeExpr, HirObjectTypeExpr } from "../../hir/nodes.js";
import type { OverloadSetId, ScopeId } from "../../ids.js";
import { createModuleContext } from "./helpers.js";
import { Expr } from "../../../parser/index.js";
import { moduleVisibility, packageVisibility } from "../../hir/index.js";

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

describe("overload resolution", () => {
  it("matches structural arguments against overload parameters", () => {
    const ctx = createModuleContext();
    const overloadSetId: OverloadSetId = 0;
    const fakeExpr = (): Expr =>
      ({ syntaxId: ctx.nextNode(), location: ctx.span } as unknown as Expr);
    const functionScope = ctx.symbolTable.rootScope as ScopeId;

    const pointAliasSymbol = ctx.symbolTable.declare({
      name: "Point",
      kind: "type",
      declaredAt: ctx.nextNode(),
    });
    const fooPointSymbol = ctx.symbolTable.declare({
      name: "foo",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const fooBoolSymbol = ctx.symbolTable.declare({
      name: "foo",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const pointParamSymbol = ctx.symbolTable.declare({
      name: "p",
      kind: "parameter",
      declaredAt: ctx.nextNode(),
    });
    const boolParamSymbol = ctx.symbolTable.declare({
      name: "flag",
      kind: "parameter",
      declaredAt: ctx.nextNode(),
    });
    const mainSymbol = ctx.symbolTable.declare({
      name: "main",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });

    const pointAliasTarget: HirObjectTypeExpr = {
      typeKind: "object",
      fields: [
        {
          name: "x",
          type: createNamedType("i32", ctx.nextNode(), ctx.span),
          span: ctx.span,
        },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    };
    const aliasDecl = ctx.decls.registerTypeAlias({
      name: "Point",
      visibility: moduleVisibility(),
      symbol: pointAliasSymbol,
      form: undefined,
      target: pointAliasTarget as unknown as Expr,
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addItem({
      kind: "type-alias",
      visibility: moduleVisibility(),
      decl: aliasDecl.id,
      symbol: pointAliasSymbol,
      target: pointAliasTarget,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const pointType = createNamedType("Point", ctx.nextNode(), ctx.span);
    const boolType = createNamedType("bool", ctx.nextNode(), ctx.span);
    const intType = createNamedType("i32", ctx.nextNode(), ctx.span);

    const fooPointDecl = ctx.decls.registerFunction({
      name: "foo",
      visibility: moduleVisibility(),
      symbol: fooPointSymbol,
      scope: functionScope,
      params: [
        {
          name: "p",
          symbol: pointParamSymbol,
          ast: undefined,
        },
      ],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: moduleVisibility(),
      symbol: fooPointSymbol,
      decl: fooPointDecl.id,
      parameters: [
        {
          symbol: pointParamSymbol,
          pattern: { kind: "identifier", symbol: pointParamSymbol },
          mutable: false,
          span: ctx.span,
          type: pointType,
        },
      ],
      returnType: intType,
      body: ctx.createLiteral("i32", "0"),
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const fooBoolDecl = ctx.decls.registerFunction({
      name: "foo",
      visibility: moduleVisibility(),
      symbol: fooBoolSymbol,
      scope: functionScope,
      params: [
        {
          name: "flag",
          symbol: boolParamSymbol,
          ast: undefined,
        },
      ],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: moduleVisibility(),
      symbol: fooBoolSymbol,
      decl: fooBoolDecl.id,
      parameters: [
        {
          symbol: boolParamSymbol,
          pattern: { kind: "identifier", symbol: boolParamSymbol },
          mutable: false,
          span: ctx.span,
          type: boolType,
        },
      ],
      returnType: boolType,
      body: ctx.createLiteral("boolean", "false"),
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const structuralArg = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "object-literal",
      literalKind: "structural",
      entries: [
        {
          kind: "field",
          name: "extra",
          value: ctx.createLiteral("i32", "1"),
          span: ctx.span,
        },
        {
          kind: "field",
          name: "x",
          value: ctx.createLiteral("i32", "2"),
          span: ctx.span,
        },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const callExpr = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "call",
      callee: ctx.builder.addExpression({
        kind: "expr",
        exprKind: "overload-set",
        name: "foo",
        set: overloadSetId,
        ast: ctx.nextNode(),
        span: ctx.span,
      }),
      args: [{ expr: structuralArg }],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const mainDecl = ctx.decls.registerFunction({
      name: "main",
      visibility: packageVisibility(),
      symbol: mainSymbol,
      scope: functionScope,
      params: [],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: packageVisibility(),
      symbol: mainSymbol,
      decl: mainDecl.id,
      parameters: [],
      returnType: intType,
      body: callExpr,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const typing = runTypingPipeline({
      symbolTable: ctx.symbolTable,
      hir: ctx.builder.finalize(),
      overloads: new Map([[overloadSetId, [fooPointSymbol, fooBoolSymbol]]]),
      decls: ctx.decls,
    });

    const callType = typing.table.getExprType(callExpr);
    expect(callType).toBeDefined();
    const callDesc = typing.arena.get(callType!);
    expect(callDesc).toMatchObject({ kind: "primitive", name: "i32" });

    const instanceKey = `${mainSymbol}<>`;
    const callTarget = typing.callTargets.get(callExpr);
    expect(callTarget?.get(instanceKey)).toEqual({
      moduleId: "local",
      symbol: fooPointSymbol,
    });
  });

  it("keeps structurally incomparable overloads ambiguous", () => {
    const ctx = createModuleContext();
    const overloadSetId: OverloadSetId = 0;
    const fakeExpr = (): Expr =>
      ({ syntaxId: ctx.nextNode(), location: ctx.span } as unknown as Expr);
    const functionScope = ctx.symbolTable.rootScope as ScopeId;

    const narrowAliasSymbol = ctx.symbolTable.declare({
      name: "Narrow",
      kind: "type",
      declaredAt: ctx.nextNode(),
    });
    const wideAliasSymbol = ctx.symbolTable.declare({
      name: "Wide",
      kind: "type",
      declaredAt: ctx.nextNode(),
    });
    const fooNarrowSymbol = ctx.symbolTable.declare({
      name: "foo",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const fooWideSymbol = ctx.symbolTable.declare({
      name: "foo",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    const narrowParamSymbol = ctx.symbolTable.declare({
      name: "value",
      kind: "parameter",
      declaredAt: ctx.nextNode(),
    });
    const wideParamSymbol = ctx.symbolTable.declare({
      name: "value",
      kind: "parameter",
      declaredAt: ctx.nextNode(),
    });
    const mainSymbol = ctx.symbolTable.declare({
      name: "main",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });

    const aliasTargets: Array<[symbol: number, name: string, target: HirObjectTypeExpr]> = [
      [
        narrowAliasSymbol,
        "Narrow",
        {
          typeKind: "object",
          fields: [
            {
              name: "x",
              type: createNamedType("i32", ctx.nextNode(), ctx.span),
              span: ctx.span,
            },
          ],
          ast: ctx.nextNode(),
          span: ctx.span,
        },
      ],
      [
        wideAliasSymbol,
        "Wide",
        {
          typeKind: "object",
          fields: [
            {
              name: "y",
              type: createNamedType("i32", ctx.nextNode(), ctx.span),
              span: ctx.span,
            },
            {
              name: "z",
              type: createNamedType("i32", ctx.nextNode(), ctx.span),
              span: ctx.span,
            },
          ],
          ast: ctx.nextNode(),
          span: ctx.span,
        },
      ],
    ];

    aliasTargets.forEach(([symbol, name, target]) => {
      const aliasDecl = ctx.decls.registerTypeAlias({
        name,
        visibility: moduleVisibility(),
        symbol,
        form: undefined,
        target: target as unknown as Expr,
        moduleIndex: ctx.nextModuleIndex(),
      });
      ctx.builder.addItem({
        kind: "type-alias",
        visibility: moduleVisibility(),
        decl: aliasDecl.id,
        symbol,
        target,
        ast: ctx.nextNode(),
        span: ctx.span,
      });
    });

    const intType = createNamedType("i32", ctx.nextNode(), ctx.span);
    const narrowType = createNamedType("Narrow", ctx.nextNode(), ctx.span);
    const wideType = createNamedType("Wide", ctx.nextNode(), ctx.span);

    const overloadDefs: Array<{
      symbol: number;
      paramSymbol: number;
      paramType: HirNamedTypeExpr;
    }> = [
      {
        symbol: fooNarrowSymbol,
        paramSymbol: narrowParamSymbol,
        paramType: narrowType,
      },
      {
        symbol: fooWideSymbol,
        paramSymbol: wideParamSymbol,
        paramType: wideType,
      },
    ];

    overloadDefs.forEach(({ symbol, paramSymbol, paramType }) => {
      const decl = ctx.decls.registerFunction({
        name: "foo",
        visibility: moduleVisibility(),
        symbol,
        scope: functionScope,
        params: [{ name: "value", symbol: paramSymbol, ast: undefined }],
        body: fakeExpr(),
        moduleIndex: ctx.nextModuleIndex(),
      });

      ctx.builder.addFunction({
        kind: "function",
        visibility: moduleVisibility(),
        symbol,
        decl: decl.id,
        parameters: [
          {
            symbol: paramSymbol,
            pattern: { kind: "identifier", symbol: paramSymbol },
            mutable: false,
            span: ctx.span,
            type: paramType,
          },
        ],
        returnType: intType,
        body: ctx.createLiteral("i32", "0"),
        ast: ctx.nextNode(),
        span: ctx.span,
      });
    });

    const structuralArg = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "object-literal",
      literalKind: "structural",
      entries: [
        {
          kind: "field",
          name: "x",
          value: ctx.createLiteral("i32", "1"),
          span: ctx.span,
        },
        {
          kind: "field",
          name: "y",
          value: ctx.createLiteral("i32", "2"),
          span: ctx.span,
        },
        {
          kind: "field",
          name: "z",
          value: ctx.createLiteral("i32", "3"),
          span: ctx.span,
        },
      ],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const callExpr = ctx.builder.addExpression({
      kind: "expr",
      exprKind: "call",
      callee: ctx.builder.addExpression({
        kind: "expr",
        exprKind: "overload-set",
        name: "foo",
        set: overloadSetId,
        ast: ctx.nextNode(),
        span: ctx.span,
      }),
      args: [{ expr: structuralArg }],
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    const mainDecl = ctx.decls.registerFunction({
      name: "main",
      visibility: packageVisibility(),
      symbol: mainSymbol,
      scope: functionScope,
      params: [],
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: packageVisibility(),
      symbol: mainSymbol,
      decl: mainDecl.id,
      parameters: [],
      returnType: intType,
      body: callExpr,
      ast: ctx.nextNode(),
      span: ctx.span,
    });

    expect(() =>
      runTypingPipeline({
        symbolTable: ctx.symbolTable,
        hir: ctx.builder.finalize(),
        overloads: new Map([[overloadSetId, [fooNarrowSymbol, fooWideSymbol]]]),
        decls: ctx.decls,
      }),
    ).toThrow(/ambiguous overload for foo/);
  });
});
