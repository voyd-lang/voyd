import type { HirExpression } from "../../hir/index.js";
import type { SymbolId, TypeId } from "../../ids.js";
import { resolveImportedValue } from "../imports.js";
import type { TypingContext } from "../types.js";
import { getSymbolName } from "../type-system.js";
import { getIntrinsicType } from "./intrinsics.js";

export const typeIdentifierExpr = (
  expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId },
  ctx: TypingContext
): TypeId => {
  ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  return getValueType(expr.symbol, ctx);
};

export const getValueType = (symbol: SymbolId, ctx: TypingContext): TypeId => {
  const cached = ctx.valueTypes.get(symbol);
  if (typeof cached === "number") {
    return cached;
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
    intrinsicUsesSignature?: boolean;
  };

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

  throw new Error(`missing value type for symbol ${record.name}`);
};
