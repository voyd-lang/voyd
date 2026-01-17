import type { CodegenContext, HirExprId, TypeId } from "../context.js";
import type { ProgramFunctionInstanceId } from "../../semantics/ids.js";
import { getRequiredExprType } from "../types.js";

export const performSiteArgTypes = ({
  exprId,
  ctx,
  typeInstanceId,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): readonly TypeId[] => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "call") {
    throw new Error("perform site missing call expression");
  }
  return expr.args.map((arg) => getRequiredExprType(arg.expr, ctx, typeInstanceId));
};
