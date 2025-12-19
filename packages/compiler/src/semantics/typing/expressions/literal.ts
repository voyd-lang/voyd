import type { HirLiteralExpr } from "../../hir/index.js";
import type { TypeId } from "../../ids.js";
import type { TypingContext } from "../types.js";
import { getPrimitiveType } from "../type-system.js";

export const typeLiteralExpr = (
  expr: HirLiteralExpr,
  ctx: TypingContext
): TypeId => {
  ctx.effects.setExprEffect(expr.id, ctx.effects.emptyRow);
  switch (expr.literalKind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64":
      return getPrimitiveType(ctx, expr.literalKind);
    case "string":
      return getPrimitiveType(ctx, "string");
    case "boolean":
      return ctx.primitives.bool;
    case "void":
      return ctx.primitives.void;
    default:
      throw new Error(`unsupported literal kind: ${expr.literalKind}`);
  }
};
