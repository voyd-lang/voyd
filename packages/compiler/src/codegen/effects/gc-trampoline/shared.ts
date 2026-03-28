import type binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "../../context.js";
import type { ContinuationEnvField } from "../effect-lowering.js";
import { getRequiredBinding, loadBindingValue } from "../../locals.js";
import { coerceValueToType, lowerValueForHeapField } from "../../structural.js";
import { getFunctionRefType } from "../../types.js";

export const handlerType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsRuntime.handlerFrameType;

export const currentHandlerValue = (
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (fnCtx.currentHandler) {
    return ctx.mod.local.get(fnCtx.currentHandler.index, fnCtx.currentHandler.type);
  }
  return ctx.mod.ref.null(handlerType(ctx));
};

export const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type =>
  getFunctionRefType({ params, result, ctx, label: "gc_trampoline" });

export const captureContinuationEnvFieldValue = ({
  field,
  siteOrder,
  ctx,
  fnCtx,
}: {
  field: ContinuationEnvField;
  siteOrder: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  switch (field.sourceKind) {
    case "site":
      return ctx.mod.i32.const(siteOrder);
    case "handler":
      return currentHandlerValue(ctx, fnCtx);
    case "param":
    case "local": {
      const binding =
        typeof field.tempId === "number"
          ? (() => {
              const tempBinding = fnCtx.tempLocals.get(field.tempId);
              if (!tempBinding) {
                throw new Error(
                  `missing temp local binding for continuation env capture (site ${siteOrder}, temp ${field.tempId})`
                );
              }
              return tempBinding;
            })()
          : (() => {
              if (typeof field.symbol !== "number") {
                throw new Error("missing symbol for env field");
              }
              return getRequiredBinding(field.symbol, ctx, fnCtx);
            })();
      const actualTypeId =
        typeof binding.typeId === "number" ? binding.typeId : field.typeId;
      const inlineValue = loadBindingValue(binding, ctx);
      const coercedValue =
        actualTypeId === field.typeId
          ? inlineValue
          : coerceValueToType({
              value: inlineValue,
              actualType: actualTypeId,
              targetType: field.typeId,
              ctx,
              fnCtx,
            });
      return field.storageType === field.wasmType
        ? coercedValue
        : lowerValueForHeapField({
            value: coercedValue,
            typeId: field.typeId,
            targetType: field.storageType,
            ctx,
            fnCtx,
          });
    }
  }
};
