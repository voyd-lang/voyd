import { bench } from "vitest";
import { moduleVisibility, packageVisibility } from "../../hir/index.js";
import type { HirGraph } from "../../hir/index.js";
import type {
  OverloadSetId,
  ScopeId,
  SourceSpan,
  SymbolId,
} from "../../ids.js";
import { Expr } from "../../../parser/index.js";
import { runTypingPipeline } from "../typing.js";
import { createModuleContext } from "./helpers.js";
import { SymbolTable } from "../../binder/index.js";
import { DeclTable } from "../../decls.js";
import { createTypingContext, createTypingState } from "../context.js";
import { getPrimitiveType, typeSatisfies } from "../type-system.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";

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

const buildOverloadFanoutInputs = (overloadCount: number) => {
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
    symbolTable: ctx.symbolTable,
    hir: ctx.builder.finalize(),
    overloads: new Map<OverloadSetId, readonly SymbolId[]>([
      [overloadSetId, overloadSymbols],
    ]),
    decls: ctx.decls,
    typeCheckBudget: {
      maxOverloadCandidates: Math.max(overloadCount, 64),
      maxUnifySteps: 100_000,
    },
  };
};

const buildUnionHeavyContext = (memberCount: number) => {
  const span: SourceSpan = { file: "<bench>", start: 0, end: 0 };
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<bench>",
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
    moduleId: "bench",
    typeCheckBudget: {
      maxUnifySteps: 100_000,
      maxOverloadCandidates: 64,
    },
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  const state = createTypingState("strict");
  const bool = getPrimitiveType(ctx, "bool");
  const members = Array.from({ length: memberCount }, (_, index) =>
    ctx.arena.internStructuralObject({
      fields: [
        { name: "value", type: bool },
        { name: `extra_${index}`, type: bool },
      ],
    }),
  );
  const actual = ctx.arena.internUnion(members);
  const expected = ctx.arena.internStructuralObject({
    fields: [{ name: "value", type: bool }],
  });
  return { ctx, state, actual, expected };
};

const overloadFanoutInputs = buildOverloadFanoutInputs(48);

bench("typing overload fanout (48 candidates)", () => {
  runTypingPipeline(overloadFanoutInputs);
});

bench("typing union-heavy type satisfaction (80 members)", () => {
  const { ctx, state, actual, expected } = buildUnionHeavyContext(80);
  typeSatisfies(actual, expected, ctx, state);
});
