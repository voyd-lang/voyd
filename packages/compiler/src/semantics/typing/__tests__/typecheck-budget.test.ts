import { describe, expect, it } from "vitest";
import type { HirGraph } from "../../hir/index.js";
import { moduleVisibility, packageVisibility } from "../../hir/index.js";
import type {
  OverloadSetId,
  ScopeId,
  SourceSpan,
  SymbolId,
  TypeId,
} from "../../ids.js";
import { Expr } from "../../../parser/index.js";
import { runTypingPipeline } from "../typing.js";
import { createModuleContext } from "./helpers.js";
import { DiagnosticError } from "../../../diagnostics/index.js";
import { SymbolTable } from "../../binder/index.js";
import { DeclTable } from "../../decls.js";
import { createTypingContext, createTypingState } from "../context.js";
import { getPrimitiveType, typeSatisfies } from "../type-system.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import type { TypeCheckBudgetConfig } from "../types.js";

const createNamedType = (
  name: string,
  ast: number,
  span: SourceSpan,
): { typeKind: "named"; path: string[]; ast: number; span: SourceSpan } => ({
  typeKind: "named",
  path: [name],
  ast,
  span,
});

const createOverloadFanoutCase = (overloadCount: number) => {
  const ctx = createModuleContext();
  const overloadSetId: OverloadSetId = 0;
  const functionScope = ctx.symbolTable.rootScope as ScopeId;
  const fakeExpr = (): Expr =>
    ({ syntaxId: ctx.nextNode(), location: ctx.span } as unknown as Expr);
  const i32 = () => createNamedType("i32", ctx.nextNode(), ctx.span);

  const overloadSymbols: SymbolId[] = [];
  for (let index = 0; index < overloadCount; index += 1) {
    const symbol = ctx.symbolTable.declare({
      name: "pick",
      kind: "value",
      declaredAt: ctx.nextNode(),
    });
    overloadSymbols.push(symbol);

    const paramCount = index === overloadCount - 1 ? 1 : 2;
    const params = Array.from({ length: paramCount }, (_, paramIndex) => {
      const paramSymbol = ctx.symbolTable.declare({
        name: `value_${index}_${paramIndex}`,
        kind: "parameter",
        declaredAt: ctx.nextNode(),
      });
      return {
        name: `value_${index}_${paramIndex}`,
        symbol: paramSymbol,
      };
    });

    const decl = ctx.decls.registerFunction({
      name: "pick",
      visibility: moduleVisibility(),
      symbol,
      scope: functionScope,
      params: params.map((entry) => ({
        name: entry.name,
        symbol: entry.symbol,
        ast: undefined,
      })),
      body: fakeExpr(),
      moduleIndex: ctx.nextModuleIndex(),
    });

    ctx.builder.addFunction({
      kind: "function",
      visibility: moduleVisibility(),
      symbol,
      decl: decl.id,
      parameters: params.map((entry) => ({
        symbol: entry.symbol,
        pattern: { kind: "identifier", symbol: entry.symbol },
        mutable: false,
        span: ctx.span,
        type: i32(),
      })),
      returnType: i32(),
      body: ctx.createLiteral("i32", `${index}`),
      ast: ctx.nextNode(),
      span: ctx.span,
    });
  }

  const mainSymbol = ctx.symbolTable.declare({
    name: "main",
    kind: "value",
    declaredAt: ctx.nextNode(),
  });
  const callExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    callee: ctx.builder.addExpression({
      kind: "expr",
      exprKind: "overload-set",
      name: "pick",
      set: overloadSetId,
      ast: ctx.nextNode(),
      span: ctx.span,
    }),
    args: [{ expr: ctx.createLiteral("i32", "1") }],
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
    returnType: i32(),
    body: callExpr,
    ast: ctx.nextNode(),
    span: ctx.span,
  });

  return {
    inputs: {
      symbolTable: ctx.symbolTable,
      hir: ctx.builder.finalize(),
      overloads: new Map<OverloadSetId, readonly SymbolId[]>([
        [overloadSetId, overloadSymbols],
      ]),
      decls: ctx.decls,
    },
    callExpr,
    mainSymbol,
    selectedSymbol: overloadSymbols[overloadSymbols.length - 1]!,
  };
};

const createTypeSatisfactionContext = (typeCheckBudget?: TypeCheckBudgetConfig) => {
  const span: SourceSpan = { file: "<test>", start: 0, end: 0 };
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<test>",
      scope: symbolTable.rootScope,
      ast: 0,
      span,
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
    typeCheckBudget,
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  const state = createTypingState("strict");
  return { ctx, state };
};

const createUnionHeavyTypes = ({
  memberCount,
  baseType,
  ctx,
}: {
  memberCount: number;
  baseType: TypeId;
  ctx: ReturnType<typeof createTypeSatisfactionContext>["ctx"];
}) => {
  const members = Array.from({ length: memberCount }, (_, index) =>
    ctx.arena.internStructuralObject({
      fields: [
        { name: "value", type: baseType },
        { name: `extra_${index}`, type: baseType },
      ],
    }),
  );
  const actual = ctx.arena.internUnion(members);
  const expected = ctx.arena.internStructuralObject({
    fields: [{ name: "value", type: baseType }],
  });
  return { actual, expected };
};

const expectDiagnosticError = (run: () => unknown): DiagnosticError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DiagnosticError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected DiagnosticError");
};

describe("type-check budgets", () => {
  it("reports TY0041 when overload fanout exceeds the candidate budget", () => {
    const fanout = createOverloadFanoutCase(18);
    const error = expectDiagnosticError(() =>
      runTypingPipeline({
        ...fanout.inputs,
        typeCheckBudget: { maxOverloadCandidates: 12 },
      }),
    );
    expect(error.diagnostic.code).toBe("TY0041");
    expect(error.diagnostic.message).toContain("pick");
  });

  it("resolves overload fanout deterministically when within budget", () => {
    const fanout = createOverloadFanoutCase(18);
    const typing = runTypingPipeline({
      ...fanout.inputs,
      typeCheckBudget: { maxOverloadCandidates: 18 },
    });

    const callType = typing.table.getExprType(fanout.callExpr);
    expect(callType).toBeDefined();
    const callDesc = typing.arena.get(callType!);
    expect(callDesc).toMatchObject({ kind: "primitive", name: "i32" });

    const callTargets = typing.callTargets.get(fanout.callExpr);
    expect(callTargets?.get(`${fanout.mainSymbol}<>`)).toEqual({
      moduleId: "local",
      symbol: fanout.selectedSymbol,
    });
  });

  it("reports TY0040 when a union-heavy comparison exceeds the unify step budget", () => {
    const { ctx, state } = createTypeSatisfactionContext({
      maxUnifySteps: 20,
    });
    const bool = getPrimitiveType(ctx, "bool");
    const { actual, expected } = createUnionHeavyTypes({
      memberCount: 60,
      baseType: bool,
      ctx,
    });

    const error = expectDiagnosticError(() =>
      typeSatisfies(actual, expected, ctx, state),
    );
    expect(error.diagnostic.code).toBe("TY0040");
  });

  it("reports TY0040 when expected-side union sweeps exhaust unify budget", () => {
    const { ctx, state } = createTypeSatisfactionContext({
      maxUnifySteps: 12,
    });
    const bool = getPrimitiveType(ctx, "bool");
    const actual = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: bool }],
    });
    const expected = ctx.arena.internUnion(
      Array.from({ length: 80 }, (_, index) =>
        ctx.arena.internStructuralObject({
          fields: [{ name: `missing_${index}`, type: bool }],
        }),
      ),
    );

    const error = expectDiagnosticError(() =>
      typeSatisfies(actual, expected, ctx, state),
    );
    expect(error.diagnostic.code).toBe("TY0040");
  });

  it("handles union-heavy comparisons when the unify budget is sufficient", () => {
    const { ctx, state } = createTypeSatisfactionContext({
      maxUnifySteps: 20_000,
    });
    const bool = getPrimitiveType(ctx, "bool");
    const { actual, expected } = createUnionHeavyTypes({
      memberCount: 60,
      baseType: bool,
      ctx,
    });

    expect(typeSatisfies(actual, expected, ctx, state)).toBe(true);
  });
});
