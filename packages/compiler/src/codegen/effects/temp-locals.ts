import type { CodegenContext, FunctionContext, TypeId } from "../context.js";
import { allocateTempLocal } from "../locals.js";
import { wasmTypeFor } from "../types.js";
import { resolveTempCaptureTypeId } from "./temp-capture-types.js";

export const getOrCreateContinuationTempLocal = ({
  tempId,
  fallbackTypeId,
  ctx,
  fnCtx,
}: {
  tempId: number;
  fallbackTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ReturnType<typeof allocateTempLocal> => {
  const existing = fnCtx.tempLocals.get(tempId);
  if (existing) return existing;

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId =
    typeof typeInstanceId === "number"
      ? resolveTempCaptureTypeId({ tempId, ctx, typeInstanceId })
      : (fallbackTypeId ??
        ctx.effectLowering.tempTypeIds.get(tempId) ??
        ctx.program.primitives.unknown);
  const local = allocateTempLocal(wasmTypeFor(typeId, ctx), fnCtx, typeId, ctx);
  fnCtx.tempLocals.set(tempId, local);
  return local;
};
