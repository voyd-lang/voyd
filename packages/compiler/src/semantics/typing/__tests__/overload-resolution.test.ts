import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { DeclTable } from "../../decls.js";
import { runTypingPipeline } from "../typing.js";
import type { HirGraph, HirNamedTypeExpr, HirObjectTypeExpr } from "../../hir/index.js";
import type { OverloadSetId, ScopeId, SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { createModuleContext } from "./helpers.js";
import { Expr } from "../../../parser/index.js";
import { moduleVisibility, packageVisibility } from "../../hir/index.js";
import { createTypingContext, createTypingState } from "../context.js";
import {
  findOverloadMatches,
  narrowOverloadMatches,
  type OverloadResolutionCandidate,
} from "../expressions/overload-resolution.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import type {
  FunctionSignature,
  FunctionTypeParam,
  ParamSignature,
  TypingContext,
} from "../types.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

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

const createScoringContext = () => {
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<test>",
      scope: symbolTable.rootScope,
      ast: 0,
      span: DUMMY_SPAN,
      items: [],
      exports: [],
    },
    items: new Map(),
    statements: new Map(),
    expressions: new Map(),
  };
  const ctx = createTypingContext({
    symbolTable,
    hir,
    overloads: new Map(),
    decls: new DeclTable(),
    moduleId: "test",
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  return { ctx, state: createTypingState() };
};

const createSignature = ({
  ctx,
  parameters,
  returnType = ctx.primitives.void,
  typeParams,
}: {
  ctx: TypingContext;
  parameters: readonly ParamSignature[];
  returnType?: TypeId;
  typeParams?: readonly FunctionTypeParam[];
}): FunctionSignature => {
  const typeId = ctx.arena.internFunction({
    parameters,
    returnType,
    effectRow: ctx.effects.emptyRow,
  });
  return {
    typeId,
    parameters,
    returnType,
    hasExplicitReturn: true,
    annotatedReturn: true,
    effectRow: ctx.effects.emptyRow,
    annotatedEffects: false,
    typeParams,
    scheme: ctx.arena.newScheme(
      typeParams?.map((param) => param.typeParam) ?? [],
      typeId,
    ),
  };
};

const createTypeParam = (
  ctx: TypingContext,
  constraint?: TypeId,
): FunctionTypeParam => {
  const typeParam = ctx.arena.freshTypeParam();
  return {
    symbol: -typeParam - 1,
    typeParam,
    constraint,
    typeRef: ctx.arena.internTypeParamRef(typeParam),
  };
};

const createCandidate = (
  symbol: SymbolId,
  signature: FunctionSignature,
): OverloadResolutionCandidate => ({ symbol, signature });

describe("overload resolution", () => {
  it("charges the overload budget only for concrete-type-compatible candidates", () => {
    const { ctx, state } = createScoringContext();
    ctx.typeCheckBudget.maxOverloadCandidates = 40;
    const candidates = Array.from({ length: 70 }, (_, index) =>
      createCandidate(
        index + 1,
        createSignature({
          ctx,
          parameters: [
            {
              type:
                index % 2 === 0
                  ? ctx.primitives.i32
                  : ctx.primitives.bool,
            },
          ],
        }),
      ),
    );

    const matches = findOverloadMatches({
      name: "large_concrete_family",
      candidates,
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: () => true,
    });

    expect(matches).toHaveLength(35);
    expect(ctx.diagnostics.diagnostics).toHaveLength(0);
  });

  it("rejects overloads whose function arguments have incompatible arity", () => {
    const { ctx, state } = createScoringContext();
    const callback = (parameterCount: number) =>
      ctx.arena.internFunction({
        parameters: Array.from({ length: parameterCount }, () => ({
          type: ctx.primitives.i32,
        })),
        returnType: ctx.primitives.i32,
        effectRow: ctx.effects.emptyRow,
      });
    const twoArguments = createCandidate(
      1,
      createSignature({ ctx, parameters: [{ type: callback(2) }] }),
    );
    const threeArguments = createCandidate(
      2,
      createSignature({ ctx, parameters: [{ type: callback(3) }] }),
    );

    const matches = findOverloadMatches({
      name: "callback_arity",
      candidates: [twoArguments, threeArguments],
      args: [{ type: callback(3) }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: () => true,
    });

    expect(matches).toEqual([threeArguments]);
  });

  it("records call-shape compatibility before argument matching", () => {
    const { ctx, state } = createScoringContext();
    const oneArg = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const twoArgs = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }, { type: ctx.primitives.i32 }],
      }),
    );

    const matches = findOverloadMatches({
      name: "shape",
      candidates: [oneArg, twoArgs],
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: () => true,
    });

    expect(matches).toEqual([oneArg]);
  });

  it("records argument compatibility separately from call shape", () => {
    const { ctx, state } = createScoringContext();
    const rejected = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const accepted = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );

    const matches = findOverloadMatches({
      name: "argument",
      candidates: [rejected, accepted],
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: (candidate) => candidate === accepted,
    });

    expect(matches).toEqual([accepted]);
  });

  it("keeps lambda compatibility as a score dimension", () => {
    const { ctx, state } = createScoringContext();
    const first = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const refined = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );

    const matches = findOverloadMatches({
      name: "refined",
      candidates: [first, refined],
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: () => true,
      scoreMatches: () =>
        new Map([
          [first, { lambdaCompatibility: 0 }],
          [refined, { lambdaCompatibility: 1 }],
        ]),
    });

    expect(matches).toEqual([refined]);
  });

  it("prefers expected-return-compatible matches as a score dimension", () => {
    const { ctx, state } = createScoringContext();
    const first = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const expected = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );

    const matches = findOverloadMatches({
      name: "expected",
      candidates: [first, expected],
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: () => true,
      expectedReturnCompatible: (candidate) => candidate === expected,
    });

    expect(matches).toEqual([expected]);
  });

  it("falls back when no expected-return-compatible candidate matches", () => {
    const { ctx, state } = createScoringContext();
    const expected = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const fallback = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );

    const matches = findOverloadMatches({
      name: "expectedFallback",
      candidates: [expected, fallback],
      args: [{ type: ctx.primitives.i32 }],
      typeArguments: undefined,
      span: DUMMY_SPAN,
      ctx,
      state,
      matchesCandidate: (candidate) => candidate === fallback,
      expectedReturnCompatible: (candidate) => candidate === expected,
    });

    expect(matches).toEqual([fallback]);
  });

  it("uses dominance before later scoring dimensions", () => {
    const { ctx, state } = createScoringContext();
    const typeParam = createTypeParam(ctx);
    const concrete = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: ctx.primitives.i32 }],
      }),
    );
    const generic = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: typeParam.typeRef }],
        typeParams: [typeParam],
      }),
    );

    const matches = narrowOverloadMatches({
      matches: [generic, concrete],
      typeArguments: undefined,
      ctx,
      state,
    });

    expect(matches).toEqual([concrete]);
  });

  it("uses genericity penalty after dominance", () => {
    const { ctx, state } = createScoringContext();
    const fieldParam = createTypeParam(ctx);
    const callbackParam = createTypeParam(ctx);
    const structuralGeneric = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [
          {
            type: ctx.arena.internStructuralObject({
              fields: [{ name: "value", type: fieldParam.typeRef }],
            }),
          },
        ],
        typeParams: [fieldParam],
      }),
    );
    const callbackReturnGeneric = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [
          {
            type: ctx.arena.internFunction({
              parameters: [{ type: ctx.primitives.i32 }],
              returnType: callbackParam.typeRef,
              effectRow: ctx.effects.emptyRow,
            }),
          },
        ],
        typeParams: [callbackParam],
      }),
    );

    const matches = narrowOverloadMatches({
      matches: [callbackReturnGeneric, structuralGeneric],
      typeArguments: undefined,
      ctx,
      state,
    });

    expect(matches).toEqual([structuralGeneric]);
  });

  it("does not reintroduce candidates eliminated by earlier score dimensions", () => {
    const { ctx, state } = createScoringContext();
    const leftParam = createTypeParam(ctx);
    const rightParam = createTypeParam(ctx);
    const callbackParam = createTypeParam(ctx);
    const leftStructural = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [
          {
            type: ctx.arena.internStructuralObject({
              fields: [{ name: "left", type: leftParam.typeRef }],
            }),
          },
        ],
        typeParams: [leftParam],
      }),
    );
    const rightStructural = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [
          {
            type: ctx.arena.internStructuralObject({
              fields: [{ name: "right", type: rightParam.typeRef }],
            }),
          },
        ],
        typeParams: [rightParam],
      }),
    );
    const callbackReturnGeneric = createCandidate(
      3,
      createSignature({
        ctx,
        parameters: [
          {
            type: ctx.arena.internFunction({
              parameters: [{ type: ctx.primitives.i32 }],
              returnType: callbackParam.typeRef,
              effectRow: ctx.effects.emptyRow,
            }),
          },
        ],
        typeParams: [callbackParam],
      }),
    );

    const matches = narrowOverloadMatches({
      matches: [callbackReturnGeneric, leftStructural, rightStructural],
      typeArguments: undefined,
      ctx,
      state,
    });

    expect(matches).toEqual([leftStructural, rightStructural]);
  });

  it("uses constraint specificity after genericity", () => {
    const { ctx, state } = createScoringContext();
    const unconstrainedParam = createTypeParam(ctx);
    const constrainedParam = createTypeParam(ctx, ctx.primitives.i32);
    const unconstrained = createCandidate(
      1,
      createSignature({
        ctx,
        parameters: [{ type: unconstrainedParam.typeRef }],
        typeParams: [unconstrainedParam],
      }),
    );
    const constrained = createCandidate(
      2,
      createSignature({
        ctx,
        parameters: [{ type: constrainedParam.typeRef }],
        typeParams: [constrainedParam],
      }),
    );

    const matches = narrowOverloadMatches({
      matches: [unconstrained, constrained],
      typeArguments: undefined,
      ctx,
      state,
    });

    expect(matches).toEqual([constrained]);
  });

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
