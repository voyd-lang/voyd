import type { CodegenContext, HirExprId, TypeId } from "../context.js";

export const performSiteArgTypes = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): readonly TypeId[] => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "call") {
    throw new Error("perform site missing call expression");
  }
  return expr.args.map((arg) => {
    const resolved =
      ctx.typing.resolvedExprTypes.get(arg.expr) ??
      ctx.typing.table.getExprType(arg.expr);
    return resolved ?? ctx.typing.primitives.unknown;
  });
};
