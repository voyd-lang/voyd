import type { HirExprId, TypeId, CodegenContext } from "../context.js";
import type { ProgramFunctionInstanceId } from "../../semantics/ids.js";
import { getRequiredExprType } from "../types.js";

type TempOrigin = {
  argExprId?: HirExprId;
  fallbackTypeId: TypeId;
};

const TEMP_ORIGINS_KEY = Symbol("effects.tempOrigins");
const TEMP_TYPES_KEY = Symbol("effects.tempTypes");

const memoized = <T>({
  key,
  ctx,
  build,
}: {
  key: symbol;
  ctx: CodegenContext;
  build: () => T;
}): T => {
  const existing = ctx.effectsState.memo.get(key);
  if (existing) {
    return existing as T;
  }
  const built = build();
  ctx.effectsState.memo.set(key, built);
  return built;
};

const tempArgExprIdFor = ({
  callExprId,
  argIndex,
  ctx,
}: {
  callExprId: HirExprId;
  argIndex: number;
  ctx: CodegenContext;
}): HirExprId | undefined => {
  const callExpr = ctx.module.hir.expressions.get(callExprId);
  if (!callExpr) return undefined;
  if (callExpr.exprKind === "call") {
    return callExpr.args[argIndex]?.expr;
  }
  if (callExpr.exprKind === "method-call") {
    return argIndex === 0
      ? callExpr.target
      : callExpr.args[argIndex - 1]?.expr;
  }
  return undefined;
};

const tempOriginsFor = (ctx: CodegenContext): Map<number, TempOrigin> =>
  memoized({
    key: TEMP_ORIGINS_KEY,
    ctx,
    build: () => {
      const byTemp = new Map<number, TempOrigin>();
      ctx.effectLowering.callArgTemps.forEach((entries, callExprId) => {
        entries.forEach((entry) => {
          if (byTemp.has(entry.tempId)) return;
          byTemp.set(entry.tempId, {
            argExprId: tempArgExprIdFor({
              callExprId,
              argIndex: entry.argIndex,
              ctx,
            }),
            fallbackTypeId: entry.typeId,
          });
        });
      });
      return byTemp;
    },
  });

export const resolveTempCaptureTypeId = ({
  tempId,
  ctx,
  typeInstanceId,
}: {
  tempId: number;
  ctx: CodegenContext;
  typeInstanceId: ProgramFunctionInstanceId;
}): TypeId => {
  const byKey = memoized({
    key: TEMP_TYPES_KEY,
    ctx,
    build: () => new Map<string, TypeId>(),
  });
  const key = `${tempId}:${typeInstanceId}`;
  const cached = byKey.get(key);
  if (typeof cached === "number") {
    return cached;
  }
  const origins = tempOriginsFor(ctx);
  const origin = origins.get(tempId);
  if (!origin) {
    throw new Error(`missing continuation temp origin ${tempId}`);
  }
  const typeId =
    typeof origin.argExprId === "number"
      ? getRequiredExprType(origin.argExprId, ctx, typeInstanceId)
      : origin.fallbackTypeId;
  byKey.set(key, typeId);
  return typeId;
};
