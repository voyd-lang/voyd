import type { CodegenContext, HirExprId, HirPattern, TypeId } from "./context.js";
import type { ProgramFunctionInstanceId } from "../semantics/ids.js";
import { wasmRuntimeTypeFor } from "./runtime-types.js";
import { buildInstanceSubstitution } from "./type-substitution.js";
import { walkHirExpression } from "./hir-walk.js";

const isMaterialTypeId = (typeId: TypeId, ctx: CodegenContext): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive" && desc.name === "unknown") {
    return false;
  }
  return desc.kind !== "type-param-ref";
};

const collectTypesForInstance = ({
  instanceId,
  rootExprId,
  ctx,
}: {
  instanceId: ProgramFunctionInstanceId;
  rootExprId: HirExprId;
  ctx: CodegenContext;
}): Set<TypeId> => {
  const collected = new Set<TypeId>();
  const subst = buildInstanceSubstitution({ ctx, typeInstanceId: instanceId });

  const record = (typeId: TypeId | undefined): void => {
    if (typeof typeId !== "number") {
      return;
    }
    const resolved = subst ? ctx.program.types.substitute(typeId, subst) : typeId;
    if (isMaterialTypeId(resolved, ctx)) {
      collected.add(resolved);
    }
  };

  const recordPattern = (pattern: HirPattern): void => {
    const typedPattern = pattern as HirPattern & { typeId?: unknown };
    record(typeof typedPattern.typeId === "number" ? (typedPattern.typeId as TypeId) : undefined);
  };
  const getExprTypeForInstance = (exprId: HirExprId): TypeId | undefined => {
    const instanceType = ctx.program.functions.getInstanceExprType(instanceId, exprId);
    if (typeof instanceType === "number") {
      return instanceType;
    }
    return (
      ctx.module.types.getResolvedExprType(exprId) ??
      ctx.module.types.getExprType(exprId)
    );
  };

  walkHirExpression({
    exprId: rootExprId,
    ctx,
    visitLambdaBodies: true,
    visitHandlerBodies: true,
    visitor: {
      onExpr: (exprId) => {
        const exprType = getExprTypeForInstance(exprId);
        record(exprType);
      },
      onPattern: (pattern) => {
        recordPattern(pattern);
      },
    },
  });

  return collected;
};

export const buildRuntimeTypeArtifacts = (
  contexts: readonly CodegenContext[]
): void => {
  contexts.forEach((ctx) => {
    const moduleFns = Array.from(ctx.module.hir.items.values()).filter(
      (item) => item.kind === "function"
    );

    for (const fn of moduleFns) {
      const metasBySymbol = ctx.functions.get(ctx.moduleId)?.get(fn.symbol) ?? [];
      if (metasBySymbol.length === 0) {
        continue;
      }

      metasBySymbol.forEach((meta) => {
        try {
          const typeIds = collectTypesForInstance({
            instanceId: meta.instanceId,
            rootExprId: fn.body,
            ctx,
          });

          typeIds.forEach((typeId) => {
            wasmRuntimeTypeFor(typeId, ctx);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `runtime RTT build failed for ${ctx.moduleId}::${fn.symbol} (instance ${meta.instanceId}): ${message}`
          );
        }
      });
    }
  });
};
