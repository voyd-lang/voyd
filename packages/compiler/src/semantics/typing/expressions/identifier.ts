import type { HirExpression, HirNamedTypeExpr } from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { resolveImportedTypeExpr, resolveImportedValue } from "../imports.js";
import type { TypingContext } from "../types.js";
import { getIntrinsicType } from "./intrinsics.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";
import { createTypingState } from "../context.js";
import { resolveTypeAlias, unifyWithBudget } from "../type-system.js";

export const typeIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: TypingContext
): TypeId => {
  ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  return getValueType(expr.symbol, ctx, { span: expr.span });
};

export const getValueType = (
  symbol: SymbolId,
  ctx: TypingContext,
  options: { span?: SourceSpan } = {}
): TypeId => {
  const cached = ctx.valueTypes.get(symbol);
  if (typeof cached === "number") {
    return cached;
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
    intrinsicUsesSignature?: boolean;
    unresolved?: boolean;
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

  const aliasConstructorTarget = metadata.aliasConstructorTarget;
  if (typeof aliasConstructorTarget === "number") {
    const targetType = getValueType(aliasConstructorTarget, ctx, options);
    const aliasConstructorAlias =
      typeof metadata.aliasConstructorAlias === "number"
        ? metadata.aliasConstructorAlias
        : undefined;
    const specialized = aliasConstructorAlias
      ? specializeAliasConstructorType({
          targetType,
          targetSymbol: aliasConstructorTarget,
          aliasSymbol: aliasConstructorAlias,
          ctx,
          span: options.span,
        })
      : targetType;
    ctx.valueTypes.set(symbol, specialized);
    if (!ctx.table.getSymbolScheme(symbol)) {
      const scheme = ctx.arena.newScheme([], specialized);
      ctx.table.setSymbolScheme(symbol, scheme);
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

const specializeAliasConstructorType = ({
  targetType,
  targetSymbol,
  aliasSymbol,
  ctx,
  span,
}: {
  targetType: TypeId;
  targetSymbol: SymbolId;
  aliasSymbol: SymbolId;
  ctx: TypingContext;
  span?: SourceSpan;
}): TypeId => {
  const signature = ctx.functions.getSignature(targetSymbol);
  if (!signature) {
    return targetType;
  }

  let aliasType: TypeId | undefined;
  try {
    aliasType = resolveTypeAlias(aliasSymbol, ctx, createTypingState(), []);
  } catch {
    aliasType = resolveImportedAliasType({
      aliasSymbol,
      ctx,
      span,
    });
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
  ctx,
  span,
}: {
  aliasSymbol: SymbolId;
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
  try {
    return resolveImportedTypeExpr({
      expr: namedAliasExpr,
      typeArgs: [],
      ctx,
      state: { mode: "strict" },
    });
  } catch {
    return undefined;
  }
};
