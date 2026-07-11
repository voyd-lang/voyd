import binaryen from "binaryen";
import { initDefaultStruct } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  FunctionContext,
  FunctionMetadata,
  HirExprId,
} from "../../context.js";
import {
  allocateTempLocal,
  loadBindingStorageRef,
  loadBindingValue,
  loadLocalValue,
  materializeOwnedBinding,
  storeLocalValue,
} from "../../locals.js";
import {
  abiTypeFor,
  getExprBinaryenType,
  getRequiredExprType,
  getSignatureSpillBoxType,
  wasmTypeFor,
} from "../../types.js";
import {
  coerceValueToType,
  liftHeapValueToInline,
  requiresStructuralConversion,
} from "../../structural.js";
import { currentHandlerValue } from "./shared.js";
import { coerceExprToWasmType } from "../../wasm-type-coercions.js";
import { captureMultivalueLanes } from "../../multivalue.js";
import {
  boxSignatureSpillValue,
  unboxSignatureSpillValue,
} from "../../signature-spill.js";
import { getOrCreateStaticEffectSpecialization } from "../../effects/static-specialization.js";

export const emitResolvedCall = ({
  meta,
  args,
  callId,
  ctx,
  fnCtx,
  options = {},
}: {
  meta: FunctionMetadata;
  args: readonly binaryen.ExpressionRef[];
  callId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  options?: CompileCallOptions;
}): CompiledExpression => {
  const stabilizeMultivalueResult = (
    value: binaryen.ExpressionRef,
    abiTypes: readonly binaryen.Type[],
  ): binaryen.ExpressionRef => {
    if (abiTypes.length <= 1) {
      return value;
    }
    const captured = captureMultivalueLanes({
      value,
      abiTypes,
      ctx,
      fnCtx,
    });
    const tuple = ctx.mod.tuple.make(captured.lanes as binaryen.ExpressionRef[]);
    if (captured.setup.length === 0) {
      return tuple;
    }
    return ctx.mod.block(null, [...captured.setup, tuple], abiTypeFor(abiTypes));
  };

  const flattenAbiArgument = (
    value: binaryen.ExpressionRef,
    abiTypes: readonly binaryen.Type[],
    typeId?: number,
  ): {
    setup: readonly binaryen.ExpressionRef[];
    args: readonly binaryen.ExpressionRef[];
  } => {
    const preserveEvaluationOrder = ({
      setup,
      args,
    }: {
      setup: readonly binaryen.ExpressionRef[];
      args: readonly binaryen.ExpressionRef[];
    }): {
      setup: readonly binaryen.ExpressionRef[];
      args: readonly binaryen.ExpressionRef[];
    } => {
      if (setup.length === 0 || args.length === 0) return { setup, args };
      return {
        setup: [],
        args: [
          ctx.mod.block(null, [...setup, args[0]!], abiTypes[0]),
          ...args.slice(1),
        ],
      };
    };
    const valueAbiTypes = binaryen.getExpressionType(value) === binaryen.none
      ? []
      : [...binaryen.expandType(binaryen.getExpressionType(value))];
    if (
      typeof typeId === "number" &&
      abiTypes.length === 1 &&
      getSignatureSpillBoxType({ typeId, ctx }) === abiTypes[0]
    ) {
      return {
        setup: [],
        args: [
          boxSignatureSpillValue({
            value,
            typeId,
            ctx,
            fnCtx,
          }),
        ],
      };
    }
    if (abiTypes.length <= 1) {
      return {
        setup: [],
        args: abiTypes.length === 0 ? [] : [value],
      };
    }
    if (valueAbiTypes.length !== abiTypes.length) {
      throw new Error(
        `call ABI flatten mismatch for ${meta.wasmName}: expected ${abiTypes.length} lanes, got ${valueAbiTypes.length}`,
      );
    }
    if (typeof typeId === "number") {
      const tempType = abiTypeFor(valueAbiTypes);
      const temp = allocateTempLocal(tempType, fnCtx, typeId, ctx);
      return preserveEvaluationOrder({
        setup: [storeLocalValue({ binding: temp, value, ctx, fnCtx })],
        args: abiTypes.map((_, index) =>
          ctx.mod.tuple.extract(loadLocalValue(temp, ctx), index),
        ),
      });
    }
    const captured = captureMultivalueLanes({
      value,
      abiTypes,
      ctx,
      fnCtx,
    });
    return preserveEvaluationOrder({
      setup: captured.setup,
      args: captured.lanes,
    });
  };

  const {
    tailPosition = false,
    expectedResultTypeId,
    typeInstanceId,
    outResultStorageRef,
  } = options;

  const lookupKey = typeInstanceId ?? meta.instanceId;
  const returnTypeId = getRequiredExprType(callId, ctx, lookupKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const intrinsicResultWasmType = getExprBinaryenType(callId, ctx, lookupKey);
  const callResultWasmType = wasmTypeFor(expectedTypeId, ctx);
  const callerReturnWasmType =
    fnCtx.returnWasmType ?? wasmTypeFor(fnCtx.returnTypeId, ctx);
  const staticSpecializedMeta =
    fnCtx.staticEffectContext
      ? getOrCreateStaticEffectSpecialization({
          ctx,
          meta,
          context: fnCtx.staticEffectContext,
        })
      : undefined;
  const resolvedMeta = staticSpecializedMeta ?? meta;
  const argSetups: binaryen.ExpressionRef[] = [];
  const staticCaptureArgs =
    staticSpecializedMeta && fnCtx.staticEffectContext
      ? fnCtx.staticEffectContext.captures.map((capture) => {
          const binding = fnCtx.bindings.get(capture.symbol);
          if (!binding) {
            throw new Error("missing static effect capture binding");
          }
          if (capture.mode === "storage-ref") {
            let storageRef = loadBindingStorageRef(binding, ctx);
            if (!storageRef && binding.kind === "scalar-aggregate") {
              const materialized = materializeOwnedBinding({
                symbol: capture.symbol,
                ctx,
                fnCtx,
              });
              argSetups.push(...materialized.setup);
              storageRef = loadBindingStorageRef(materialized.binding, ctx);
            }
            if (!storageRef) {
              throw new Error("missing static effect capture storage ref");
            }
            return storageRef;
          }
          return loadBindingValue(binding, ctx, fnCtx);
      })
      : [];

  const allArgs = [...args, ...staticCaptureArgs];
  const userArgs = allArgs.flatMap((arg, index) => {
    const typeId =
      resolvedMeta.scalarAggregateParamIndexes?.includes(index) ||
      (resolvedMeta.parameters[index]?.defaulted === true &&
        !resolvedMeta.callShape)
      ? undefined
      : resolvedMeta.paramTypeIds[index];
    const flattened = flattenAbiArgument(
      arg,
      resolvedMeta.paramAbiTypes[index] ?? [binaryen.getExpressionType(arg)],
      typeId,
    );
    argSetups.push(...flattened.setup);
    return flattened.args;
  });
  const usingProvidedWideResultStorage =
    !resolvedMeta.effectful &&
    resolvedMeta.resultAbiKind === "out_ref" &&
    typeof outResultStorageRef === "number";
  const wideResultStorage =
    resolvedMeta.resultAbiKind === "out_ref"
      ? (() => {
          if (usingProvidedWideResultStorage) {
            return undefined;
          }
          if (typeof resolvedMeta.outParamType !== "number") {
            throw new Error(
              `codegen missing out param storage for ${resolvedMeta.wasmName}`,
            );
          }
          return allocateTempLocal(resolvedMeta.outParamType, fnCtx);
        })()
      : undefined;
  const initializedWideResultStorage = usingProvidedWideResultStorage
    ? outResultStorageRef
    : wideResultStorage
      ? ctx.mod.local.tee(
          wideResultStorage.index,
          initDefaultStruct(ctx.mod, wideResultStorage.type),
          wideResultStorage.type,
        )
      : undefined;
  const callArgs = resolvedMeta.effectful
    ? [
        currentHandlerValue(ctx, fnCtx),
        ...(initializedWideResultStorage
          ? [initializedWideResultStorage]
          : []),
        ...userArgs,
      ]
      : [
        ...(initializedWideResultStorage
          ? [initializedWideResultStorage]
          : []),
        ...userArgs,
      ];

  if (resolvedMeta.effectful) {
    const rawCall = ctx.mod.call(
      resolvedMeta.wasmName,
      callArgs as number[],
      resolvedMeta.resultType,
    );
    const callExpr =
      argSetups.length === 0
        ? rawCall
        : ctx.mod.block(
            null,
            [...argSetups, rawCall],
            resolvedMeta.resultType,
          );
    return ctx.effectsBackend.lowerEffectfulCallResult({
      callExpr,
      callId,
      returnTypeId,
      expectedResultTypeId,
      tailPosition,
      typeInstanceId,
      ctx,
      fnCtx,
    });
  }

  const allowReturnCall =
    resolvedMeta.resultAbiKind === "direct" &&
    argSetups.length === 0 &&
    tailPosition &&
    !fnCtx.effectful &&
    resolvedMeta.resultTypeId === expectedTypeId &&
    returnTypeId === expectedTypeId &&
    resolvedMeta.resultType === callerReturnWasmType &&
    intrinsicResultWasmType === callerReturnWasmType &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx);

  if (allowReturnCall) {
    return {
      expr: ctx.mod.return_call(
        resolvedMeta.wasmName,
        callArgs as number[],
        intrinsicResultWasmType
      ),
      usedReturnCall: true,
    };
  }

  const rawCall = ctx.mod.call(
    resolvedMeta.wasmName,
    callArgs as number[],
    resolvedMeta.resultType,
  );
  if (usingProvidedWideResultStorage) {
    const ops =
      argSetups.length === 0
        ? [rawCall]
        : [...argSetups, rawCall];
    return {
      expr: ctx.mod.block(null, ops, binaryen.none),
      usedReturnCall: false,
      usedOutResultStorageRef: true,
    };
  }
  if (resolvedMeta.resultAbiKind === "out_ref" && wideResultStorage) {
    const reloaded = liftHeapValueToInline({
      value: ctx.mod.local.get(
        wideResultStorage.index,
        wideResultStorage.type,
      ),
      typeId: resolvedMeta.resultTypeId,
      ctx,
    });
    const coerced =
      resolvedMeta.resultTypeId === expectedTypeId
        ? reloaded
        : coerceValueToType({
            value: reloaded,
            actualType: resolvedMeta.resultTypeId,
            targetType: expectedTypeId,
            ctx,
            fnCtx,
          });
    const ops =
      argSetups.length === 0
        ? [rawCall, coerceExprToWasmType({ expr: coerced, targetType: callResultWasmType, ctx })]
        : [
            ...argSetups,
            rawCall,
            coerceExprToWasmType({ expr: coerced, targetType: callResultWasmType, ctx }),
          ];
    return {
      expr: ctx.mod.block(null, ops, callResultWasmType),
      usedReturnCall: false,
    };
  }
  const stabilizedCall = stabilizeMultivalueResult(
    rawCall,
    resolvedMeta.resultAbiTypes,
  );
  if (resolvedMeta.scalarAggregateResult) {
    const callExpr =
      argSetups.length === 0
        ? stabilizedCall
        : ctx.mod.block(
            null,
            [...argSetups, stabilizedCall],
            binaryen.getExpressionType(stabilizedCall),
          );
    return {
      expr: callExpr,
      usedReturnCall: false,
      usedScalarAggregateResult: true,
    };
  }
  const decodedCall =
    getSignatureSpillBoxType({ typeId: resolvedMeta.resultTypeId, ctx }) ===
    resolvedMeta.resultType
      ? unboxSignatureSpillValue({
          value: stabilizedCall,
          typeId: resolvedMeta.resultTypeId,
          ctx,
        })
      : stabilizedCall;
  const callExpr =
    argSetups.length === 0
      ? decodedCall
      : ctx.mod.block(
          null,
          [...argSetups, decodedCall],
          binaryen.getExpressionType(decodedCall),
        );
  const coercedCall =
    resolvedMeta.resultTypeId === expectedTypeId
      ? callExpr
      : coerceValueToType({
          value: callExpr,
          actualType: resolvedMeta.resultTypeId,
          targetType: expectedTypeId,
          ctx,
          fnCtx,
        });
  return {
    expr: coerceExprToWasmType({
      expr: coercedCall,
      targetType: callResultWasmType,
      ctx,
    }),
    usedReturnCall: false,
  };
};
