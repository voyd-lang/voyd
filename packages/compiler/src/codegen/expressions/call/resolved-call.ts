import binaryen from "binaryen";
import { initDefaultStruct } from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  FunctionContext,
  FunctionMetadata,
  HirExprId,
} from "../../context.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "../../locals.js";
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
      return {
        setup: [storeLocalValue({ binding: temp, value, ctx, fnCtx })],
        args: abiTypes.map((_, index) =>
          ctx.mod.tuple.extract(loadLocalValue(temp, ctx), index),
        ),
      };
    }
    const captured = captureMultivalueLanes({
      value,
      abiTypes,
      ctx,
      fnCtx,
    });
    return {
      setup: captured.setup,
      args: captured.lanes,
    };
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

  const argSetups: binaryen.ExpressionRef[] = [];
  const userArgs = args.flatMap((arg, index) => {
    const flattened = flattenAbiArgument(
      arg,
      meta.paramAbiTypes[index] ?? [binaryen.getExpressionType(arg)],
      meta.paramTypeIds[index],
    );
    argSetups.push(...flattened.setup);
    return flattened.args;
  });
  const usingProvidedWideResultStorage =
    !meta.effectful &&
    meta.resultAbiKind === "out_ref" &&
    typeof outResultStorageRef === "number";
  const wideResultStorage =
    meta.resultAbiKind === "out_ref"
      ? (() => {
          if (usingProvidedWideResultStorage) {
            return undefined;
          }
          if (typeof meta.outParamType !== "number") {
            throw new Error(
              `codegen missing out param storage for ${meta.wasmName}`,
            );
          }
          return allocateTempLocal(meta.outParamType, fnCtx);
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
  const callArgs = meta.effectful
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

  if (meta.effectful) {
    const rawCall = ctx.mod.call(meta.wasmName, callArgs as number[], meta.resultType);
    const stabilizedCall = stabilizeMultivalueResult(
      rawCall,
      meta.resultAbiTypes,
    );
    const decodedCall =
      getSignatureSpillBoxType({ typeId: meta.resultTypeId, ctx }) === meta.resultType
        ? unboxSignatureSpillValue({
            value: stabilizedCall,
            typeId: meta.resultTypeId,
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
    meta.resultAbiKind === "direct" &&
    argSetups.length === 0 &&
    tailPosition &&
    !fnCtx.effectful &&
    meta.resultTypeId === expectedTypeId &&
    returnTypeId === expectedTypeId &&
    meta.resultType === callerReturnWasmType &&
    intrinsicResultWasmType === callerReturnWasmType &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx);

  if (allowReturnCall) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        callArgs as number[],
        intrinsicResultWasmType
      ),
      usedReturnCall: true,
    };
  }

  const rawCall = ctx.mod.call(meta.wasmName, callArgs as number[], meta.resultType);
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
  if (meta.resultAbiKind === "out_ref" && wideResultStorage) {
    const reloaded = liftHeapValueToInline({
      value: ctx.mod.local.get(
        wideResultStorage.index,
        wideResultStorage.type,
      ),
      typeId: meta.resultTypeId,
      ctx,
    });
    const coerced =
      meta.resultTypeId === expectedTypeId
        ? reloaded
        : coerceValueToType({
            value: reloaded,
            actualType: meta.resultTypeId,
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
    meta.resultAbiTypes,
  );
  const decodedCall =
    getSignatureSpillBoxType({ typeId: meta.resultTypeId, ctx }) === meta.resultType
      ? unboxSignatureSpillValue({
          value: stabilizedCall,
          typeId: meta.resultTypeId,
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
    meta.resultTypeId === expectedTypeId
      ? callExpr
      : coerceValueToType({
          value: callExpr,
          actualType: meta.resultTypeId,
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
