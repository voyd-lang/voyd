import type {
  CodegenContext,
  FunctionContext,
  HirFieldAccessExpr,
  TypeId,
} from "../context.js";

const exactNominalForType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId | undefined;
  ctx: CodegenContext;
}): TypeId | undefined => {
  if (typeof typeId !== "number") {
    return undefined;
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

export const exactNominalForRuntimeTypeCheckElision = ({
  expr,
  targetTypeId,
  ctx,
  fnCtx,
}: {
  expr: HirFieldAccessExpr;
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): TypeId | undefined => {
  if (
    !ctx.optimization?.runtimeTypeCheckElisionFieldAccesses
      .get(ctx.moduleId)
      ?.has(expr.id)
  ) {
    return undefined;
  }

  const targetExpr = ctx.module.hir.expressions.get(expr.target);
  if (targetExpr?.exprKind === "identifier") {
    const exactParameterType = fnCtx.exactParameterTypes?.get(targetExpr.symbol);
    if (typeof exactParameterType === "number") {
      return exactParameterType;
    }
  }

  return exactNominalForType({ typeId: targetTypeId, ctx });
};
