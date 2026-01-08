import type { CodegenContext, HirExprId, TypeId } from "../context.js";

export const performSiteArgTypes = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): readonly TypeId[] => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "call") {
    throw new Error("perform site missing call expression");
  }
  return expr.args.map((arg) => {
    const resolved =
      ctx.module.types.getResolvedExprType(arg.expr) ??
      ctx.module.types.getExprType(arg.expr);
    return resolved ?? ctx.program.primitives.unknown;
  });
};
