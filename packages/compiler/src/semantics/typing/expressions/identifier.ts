import type {
  HirExpression,
  HirModuleLet,
  HirNamedTypeExpr,
  HirTypeExpr,
} from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { resolveImportedTypeExpr, resolveImportedValue } from "../imports.js";
import type { TypingContext, TypingState } from "../types.js";
import { getIntrinsicType } from "./intrinsics.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";
import { createTypingState } from "../context.js";
import { typeExpression } from "../expressions.js";
import { ensureEffectCompatibility, getExprEffectRow } from "../effects.js";
import { resolveTypeAlias, resolveTypeExpr, unifyWithBudget } from "../type-system.js";

export const typeIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: TypingContext,
  state: TypingState,
): TypeId => {
  ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  const aliasConstructorTypeArguments = resolveIdentifierTypeArguments({
    typeArguments: expr.typeArguments,
    ctx,
    state,
  });
  return getValueType(expr.symbol, ctx, {
    span: expr.span,
    aliasConstructorTypeArguments,
  });
};

export const getValueType = (
  symbol: SymbolId,
  ctx: TypingContext,
  options: {
    span?: SourceSpan;
    aliasConstructorTypeArguments?: readonly TypeId[];
  } = {},
): TypeId => {
  const hasExplicitAliasConstructorTypeArguments =
    (options.aliasConstructorTypeArguments?.length ?? 0) > 0;
  if (!hasExplicitAliasConstructorTypeArguments) {
    const cached = ctx.valueTypes.get(symbol);
    if (typeof cached === "number") {
      return cached;
    }
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
    intrinsicUsesSignature?: boolean;
    unresolved?: boolean;
    moduleLet?: unknown;
    aliasConstructorTarget?: unknown;
    aliasConstructorAlias?: unknown;
  };

  if (metadata.unresolved === true) {
    return emitDiagnostic({
      ctx,
      code: "TY0030",
      params: { kind: "undefined-identifier", name: record.name },
      span: normalizeSpan(options.span),
    });
  }

  if (ctx.activeValueTypeComputations.has(symbol)) {
    return emitDiagnostic({
      ctx,
      code: "TY0031",
      params: { kind: "self-referential-initializer", name: record.name },
      span: normalizeSpan(options.span),
    });
  }

  if (metadata.intrinsic && metadata.intrinsicUsesSignature === true) {
    const signature = ctx.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(`missing signature for intrinsic ${record.name}`);
    }
    const functionType =
      signature.typeId ??
      ctx.arena.internFunction({
        parameters: signature.parameters.map(({ type, label }) => ({
          type,
          label,
          optional: false,
        })),
        returnType: signature.returnType,
        effectRow: signature.effectRow ?? ctx.primitives.defaultEffectRow,
      });
    ctx.valueTypes.set(symbol, functionType);
    if (!ctx.table.getSymbolScheme(symbol)) {
      const typeParams =
        signature.typeParams?.map((param) => param.typeParam) ?? [];
      const scheme = ctx.arena.newScheme(typeParams, functionType);
      ctx.table.setSymbolScheme(symbol, scheme);
    }
    return functionType;
  }

  if (metadata.intrinsic && metadata.intrinsicUsesSignature !== true) {
    const intrinsicType = getIntrinsicType(
      metadata.intrinsicName ?? record.name,
      ctx
    );
    ctx.valueTypes.set(symbol, intrinsicType);

    if (!ctx.table.getSymbolScheme(symbol)) {
      const scheme = ctx.arena.newScheme([], intrinsicType);
      ctx.table.setSymbolScheme(symbol, scheme);
    }

    return intrinsicType;
  }

  const importMetadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    import?: unknown;
  };
  if (importMetadata.import) {
    const imported = resolveImportedValue({ symbol, ctx });
    if (imported) {
      return imported.type;
    }
    const unknownType = ctx.primitives.unknown;
    ctx.valueTypes.set(symbol, unknownType);
    if (!ctx.table.getSymbolScheme(symbol)) {
      const scheme = ctx.arena.newScheme([], unknownType);
      ctx.table.setSymbolScheme(symbol, scheme);
    }
    return unknownType;
  }

  if (metadata.moduleLet === true) {
    return resolveModuleLetValueType({
      symbol,
      ctx,
      span: options.span,
    });
  }

  const aliasConstructorTarget = metadata.aliasConstructorTarget;
  if (typeof aliasConstructorTarget === "number") {
    const targetType = getValueType(aliasConstructorTarget, ctx, {
      span: options.span,
    });
    const aliasConstructorAlias =
      typeof metadata.aliasConstructorAlias === "number"
        ? metadata.aliasConstructorAlias
        : undefined;
    const specialized = aliasConstructorAlias
      ? specializeAliasConstructorType({
          targetType,
          targetSymbol: aliasConstructorTarget,
          aliasSymbol: aliasConstructorAlias,
          aliasTypeArguments: options.aliasConstructorTypeArguments ?? [],
          ctx,
          span: options.span,
        })
      : targetType;
    if (!hasExplicitAliasConstructorTypeArguments) {
      ctx.valueTypes.set(symbol, specialized);
      if (!ctx.table.getSymbolScheme(symbol)) {
        const scheme = ctx.arena.newScheme([], specialized);
        ctx.table.setSymbolScheme(symbol, scheme);
      }
    }
    return specialized;
  }

  return emitDiagnostic({
    ctx,
    code: "TY0041",
    params: {
      kind: "symbol-not-a-value",
      name: record.name,
      symbolKind: record.kind,
    },
    span: normalizeSpan(options.span),
  });
};

const resolveModuleLetValueType = ({
  symbol,
  ctx,
  span,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
  span?: SourceSpan;
}): TypeId => {
  const cached = ctx.valueTypes.get(symbol);
  if (typeof cached === "number") {
    return cached;
  }

  const moduleLet = findModuleLetItem(symbol, ctx);
  if (!moduleLet) {
    throw new Error(`missing HIR module-let for symbol ${symbol}`);
  }

  const moduleLetState = createTypingState();
  const annotationType = moduleLet.typeAnnotation
    ? resolveTypeExpr(
        moduleLet.typeAnnotation,
        ctx,
        moduleLetState,
        ctx.primitives.unknown,
      )
    : undefined;
  moduleLetState.currentFunction = {
    returnType:
      typeof annotationType === "number" ? annotationType : ctx.primitives.unknown,
    instanceKey: `${symbol}<>`,
    functionSymbol: symbol,
  };

  const moduleLetSpan = normalizeSpan(span ?? moduleLet.span);
  const symbolName = ctx.symbolTable.getSymbol(symbol).name;
  ctx.activeValueTypeComputations.add(symbol);
  try {
    const inferred = typeExpression(
      moduleLet.initializer,
      ctx,
      moduleLetState,
      typeof annotationType === "number"
        ? { expectedType: annotationType }
        : {},
    );
    const finalType =
      typeof annotationType === "number" ? annotationType : inferred;
    ctx.valueTypes.set(symbol, finalType);
    ctx.table.setSymbolScheme(symbol, ctx.arena.newScheme([], finalType));

    ensureEffectCompatibility({
      inferred: getExprEffectRow(moduleLet.initializer, ctx),
      annotated: ctx.primitives.defaultEffectRow,
      ctx,
      span: moduleLetSpan,
      location: moduleLet.ast,
      reason: `module let ${symbolName} initializer effects`,
    });

    return finalType;
  } finally {
    ctx.activeValueTypeComputations.delete(symbol);
  }
};

const findModuleLetItem = (
  symbol: SymbolId,
  ctx: TypingContext,
): HirModuleLet | undefined =>
  Array.from(ctx.hir.items.values()).find(
    (item): item is HirModuleLet =>
      item.kind === "module-let" && item.symbol === symbol,
  );

const specializeAliasConstructorType = ({
  targetType,
  targetSymbol,
  aliasSymbol,
  aliasTypeArguments,
  ctx,
  span,
}: {
  targetType: TypeId;
  targetSymbol: SymbolId;
  aliasSymbol: SymbolId;
  aliasTypeArguments: readonly TypeId[];
  ctx: TypingContext;
  span?: SourceSpan;
}): TypeId => {
  const signature = ctx.functions.getSignature(targetSymbol);
  if (!signature) {
    return targetType;
  }

  const aliasRecord = ctx.symbolTable.getSymbol(aliasSymbol);
  const aliasMetadata = aliasRecord.metadata as { import?: unknown } | undefined;

  let aliasType: TypeId | undefined;
  try {
    aliasType =
      aliasMetadata?.import !== undefined
        ? resolveImportedAliasType({
            aliasSymbol,
            typeArguments: aliasTypeArguments,
            ctx,
            span,
          })
        : resolveTypeAlias(
            aliasSymbol,
            ctx,
            createTypingState(),
            aliasTypeArguments,
          );
  } catch (error) {
    if (shouldDeferAliasConstructorSpecialization({ error, aliasTypeArguments })) {
      return targetType;
    }
    throw error;
  }
  if (typeof aliasType !== "number") {
    return targetType;
  }

  const unified = unifyWithBudget({
    actual: aliasType,
    expected: signature.returnType,
    options: {
      location: ctx.hir.module.ast,
      reason: "alias constructor value specialization",
      allowUnknown: true,
    },
    ctx,
    span: normalizeSpan(span),
  });
  if (!unified.ok) {
    return targetType;
  }
  return ctx.arena.substitute(signature.typeId, unified.substitution);
};

const resolveImportedAliasType = ({
  aliasSymbol,
  typeArguments,
  ctx,
  span,
}: {
  aliasSymbol: SymbolId;
  typeArguments: readonly TypeId[];
  ctx: TypingContext;
  span?: SourceSpan;
}): TypeId | undefined => {
  const aliasRecord = ctx.symbolTable.getSymbol(aliasSymbol);
  const namedAliasExpr: HirNamedTypeExpr = {
    typeKind: "named",
    path: [aliasRecord.name],
    symbol: aliasSymbol,
    ast: ctx.hir.module.ast,
    span: normalizeSpan(span),
  };
  return resolveImportedTypeExpr({
    expr: namedAliasExpr,
    typeArgs: typeArguments,
    ctx,
    state: { mode: "strict" },
  });
};

const shouldDeferAliasConstructorSpecialization = ({
  error,
  aliasTypeArguments,
}: {
  error: unknown;
  aliasTypeArguments: readonly TypeId[];
}): boolean => {
  if (aliasTypeArguments.length > 0 || !(error instanceof Error)) {
    return false;
  }
  return /missing \d+ type argument\(s\)/i.test(error.message);
};

const resolveIdentifierTypeArguments = ({
  typeArguments,
  ctx,
  state,
}: {
  typeArguments: readonly HirTypeExpr[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): TypeId[] | undefined => {
  if (!typeArguments || typeArguments.length === 0) {
    return undefined;
  }
  return typeArguments.map((typeArgument) =>
    resolveTypeExpr(typeArgument, ctx, state, ctx.primitives.unknown),
  );
};
