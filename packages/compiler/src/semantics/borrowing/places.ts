import type { HirGraph } from "../hir/index.js";
import type { HirExprId } from "../ids.js";
import {
  callHasIntrinsicBorrowBoundary,
  expressionTypeFor,
  type ResolveContext,
} from "./call-resolution.js";
import type { BorrowPlace } from "./model.js";
import { typeIsAllocationBacked } from "./reference-bearing.js";

/**
 * Resolve the small place vocabulary shared by the cheap index and full facts.
 * This helper deliberately does not own facts, CFG state, or provenance.
 */
export const placeOfExpression = (
  exprId: HirExprId,
  hir: HirGraph,
  resolveContext?: ResolveContext,
): BorrowPlace | undefined => {
  const expression = hir.expressions.get(exprId);
  if (expression?.exprKind === "identifier") {
    return { root: expression.symbol, projections: [] };
  }
  if (expression?.exprKind === "call" && resolveContext) {
    const callee = hir.expressions.get(expression.callee);
    const metadata =
      callee?.exprKind === "identifier"
        ? (resolveContext.symbolTable.getSymbol(callee.symbol).metadata as
            | { intrinsic?: boolean; intrinsicName?: string }
            | undefined)
        : undefined;
    const name =
      callee?.exprKind === "identifier"
        ? (metadata?.intrinsicName ??
          resolveContext.symbolTable.getSymbol(callee.symbol).name)
        : undefined;
    const intrinsicBoundary = callHasIntrinsicBorrowBoundary(
      expression,
      resolveContext,
    );
    if (intrinsicBoundary && name === "~") {
      const argument = expression.args.at(-1)?.expr;
      return typeof argument === "number"
        ? placeOfExpression(argument, hir, resolveContext)
        : undefined;
    }
    if (intrinsicBoundary && name === "__array_get") {
      const target = expression.args[0]?.expr;
      if (typeof target !== "number") return undefined;
      const place = placeOfExpression(target, hir, resolveContext);
      if (!place) return undefined;
      const index = expression.args[1]?.expr;
      const indexExpression =
        typeof index === "number" ? hir.expressions.get(index) : undefined;
      const constant =
        indexExpression?.exprKind === "literal" &&
        indexExpression.literalKind === "i32"
          ? Number(indexExpression.value)
          : undefined;
      return {
        root: place.root,
        projections: [
          ...place.projections,
          ...(typeof expressionTypeFor(target, resolveContext) === "number" &&
          typeIsAllocationBacked(
            expressionTypeFor(target, resolveContext)!,
            resolveContext.typing,
          )
            ? ([{ kind: "dereference" }] as const)
            : []),
          {
            kind: "index",
            stable: true,
            ...(Number.isInteger(constant) ? { constant } : {}),
          },
        ],
      };
    }
  }
  if (expression?.exprKind !== "field-access") {
    return undefined;
  }
  const target = placeOfExpression(expression.target, hir, resolveContext);
  if (!target) {
    return undefined;
  }
  const projection = Number.isInteger(Number(expression.field))
    ? ({ kind: "tuple", index: Number(expression.field) } as const)
    : ({ kind: "field", name: expression.field } as const);
  const targetType = resolveContext
    ? expressionTypeFor(expression.target, resolveContext)
    : undefined;
  const targetExpression = hir.expressions.get(expression.target);
  const needsDereference =
    typeof targetType === "number" &&
    typeIsAllocationBacked(targetType, resolveContext!.typing) &&
    resolveContext!.typing.arena.get(targetType).kind !== "borrowed" &&
    targetExpression?.exprKind !== "identifier";
  return {
    root: target.root,
    projections: [
      ...target.projections,
      ...(needsDereference ? ([{ kind: "dereference" }] as const) : []),
      projection,
    ],
  };
};
