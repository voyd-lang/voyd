import binaryen from "binaryen";
import {
  defineStructType,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  HirFunction,
  HirLambdaExpr,
  HirPattern,
  HirEffectHandlerExpr,
  SymbolId,
  TypeId,
} from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { walkHirExpression, walkHirPattern } from "../../hir-walk.js";
import type { ContinuationEnvField } from "./types.js";
import { effectsFacade } from "../facade.js";

export const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

export const shouldLowerLambda = (
  expr: HirLambdaExpr,
  ctx: CodegenContext
): boolean => (effectsFacade(ctx).lambdaAbi(expr.id)?.shouldLower ?? false);

const collectPatternSymbols = (pattern: HirPattern, into: Set<SymbolId>): void => {
  switch (pattern.kind) {
    case "identifier":
      into.add(pattern.symbol);
      return;
    case "destructure":
      pattern.fields.forEach((field) => collectPatternSymbols(field.pattern, into));
      if (pattern.spread) {
        collectPatternSymbols(pattern.spread, into);
      }
      return;
    case "tuple":
      pattern.elements.forEach((element) => collectPatternSymbols(element, into));
      return;
    case "type":
      if (pattern.binding) {
        collectPatternSymbols(pattern.binding, into);
      }
      return;
    case "wildcard":
      return;
  }
};

export const functionParamSymbols = (fn: HirFunction): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  fn.parameters.forEach((param) => collectPatternSymbols(param.pattern, symbols));
  return symbols;
};

export const lambdaParamSymbols = (expr: HirLambdaExpr): ReadonlySet<SymbolId> =>
  new Set(expr.parameters.map((param) => param.symbol));

export const handlerClauseParamSymbols = (
  clause: HirEffectHandlerExpr["handlers"][number]
): ReadonlySet<SymbolId> => new Set(clause.parameters.map((param) => param.symbol));

export const definitionOrderForFunction = (
  fn: HirFunction,
  ctx: CodegenContext
): Map<SymbolId, number> => {
  const order = new Map<SymbolId, number>();
  let index = 0;

  const add = (symbol: SymbolId): void => {
    if (order.has(symbol)) return;
    order.set(symbol, index);
    index += 1;
  };

  const visitor = {
    onPattern: (pattern: HirPattern) => {
      if (pattern.kind !== "identifier") return;
      add(pattern.symbol);
    },
  };

  fn.parameters.forEach((param) => {
    walkHirPattern({ pattern: param.pattern, visitor });
  });
  walkHirExpression({ exprId: fn.body, ctx, visitLambdaBodies: false, visitor });
  return order;
};

export const definitionOrderForLambda = (
  expr: HirLambdaExpr,
  ctx: CodegenContext
): Map<SymbolId, number> => {
  const order = new Map<SymbolId, number>();
  let index = 0;

  const add = (symbol: SymbolId): void => {
    if (order.has(symbol)) return;
    order.set(symbol, index);
    index += 1;
  };

  expr.captures.forEach((capture) => add(capture.symbol));
  expr.parameters.forEach((param) => add(param.symbol));

  walkHirExpression({
    exprId: expr.body,
    ctx,
    visitLambdaBodies: false,
    visitor: {
      onPattern: (pattern) => {
        if (pattern.kind !== "identifier") return;
        add(pattern.symbol);
      },
    },
  });
  return order;
};

const shouldCaptureIdentifierSymbol = (symbol: SymbolId, ctx: CodegenContext): boolean =>
  ctx.symbolTable.getScope(ctx.symbolTable.getSymbol(symbol).scope).kind !== "module";

export const definitionOrderForHandlerClause = ({
  clause,
  ctx,
}: {
  clause: HirEffectHandlerExpr["handlers"][number];
  ctx: CodegenContext;
}): Map<SymbolId, number> => {
  const order = new Map<SymbolId, number>();
  let index = 0;

  const add = (symbol: SymbolId): void => {
    if (order.has(symbol)) return;
    order.set(symbol, index);
    index += 1;
  };

  clause.parameters.forEach((param) => add(param.symbol));

  walkHirExpression({
    exprId: clause.body,
    ctx,
    visitLambdaBodies: false,
    visitor: {
      onPattern: (pattern) => {
        if (pattern.kind !== "identifier") return;
        add(pattern.symbol);
      },
      onExpr: (_exprId, expr) => {
        if (expr.exprKind !== "identifier") return;
        if (!shouldCaptureIdentifierSymbol(expr.symbol, ctx)) return;
        add(expr.symbol);
      },
    },
  });

  return order;
};

export const envFieldsFor = ({
  liveSymbols,
  params,
  ordering,
  ctx,
}: {
  liveSymbols: ReadonlySet<SymbolId>;
  params: ReadonlySet<SymbolId>;
  ordering: Map<SymbolId, number>;
  ctx: CodegenContext;
}): ContinuationEnvField[] =>
  Array.from(liveSymbols)
    .filter((symbol) => params.has(symbol) || ordering.has(symbol))
    .sort((a, b) => (ordering.get(a) ?? 0) - (ordering.get(b) ?? 0))
    .map((symbol) => {
      const typeId = ctx.typing.valueTypes.get(symbol) ?? ctx.typing.primitives.unknown;
      return {
        name: ctx.symbolTable.getSymbol(symbol).name,
        symbol,
        typeId,
        wasmType: wasmTypeFor(typeId, ctx),
        sourceKind: params.has(symbol) ? "param" : "local",
      };
    });

export const ensureArgsType = ({
  opSymbol,
  paramTypes,
  ctx,
  cache,
}: {
  opSymbol: SymbolId;
  paramTypes: readonly TypeId[];
  ctx: CodegenContext;
  cache: Map<SymbolId, binaryen.Type>;
}): binaryen.Type | undefined => {
  if (paramTypes.length === 0) return undefined;

  const cached = cache.get(opSymbol);
  if (cached) return cached;

  const fields = paramTypes.map((typeId, index) => ({
    name: `arg${index}`,
    type: wasmTypeFor(typeId, ctx),
    mutable: false,
  }));
  const type = defineStructType(ctx.mod, {
    name: `voydEffectArgs_${sanitizeIdentifier(ctx.symbolTable.getSymbol(opSymbol).name)}`,
    fields,
    final: true,
  });
  cache.set(opSymbol, type);
  return type;
};
