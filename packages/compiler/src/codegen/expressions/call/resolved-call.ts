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
import {
  compileRuntimeIdentityConflict,
  compileRuntimeIdentityGuard,
  projectRuntimeAllocationIdentity,
  runtimeIdentityForGuardOperand,
} from "../../runtime-identity-guards.js";
import { getOrCreateDefaultIdentityGuardEntry } from "../../default-identity-guard-entry.js";

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
    const tuple = ctx.mod.tuple.make(
      captured.lanes as binaryen.ExpressionRef[],
    );
    if (captured.setup.length === 0) {
      return tuple;
    }
    return ctx.mod.block(
      null,
      [...captured.setup, tuple],
      abiTypeFor(abiTypes),
    );
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
    const valueAbiTypes =
      binaryen.getExpressionType(value) === binaryen.none
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
  const identityGuards = ctx.program.calls.getCallInfo(
    ctx.moduleId,
    callId,
  ).identityGuards;
  const immediateIdentityGuards = identityGuards.filter(
    (guard) => !guard.afterDefaults,
  );
  const deferredIdentityGuards = identityGuards.filter(
    (guard) => guard.afterDefaults,
  );
  deferredIdentityGuards.forEach((guard) => {
    if (guard.defaultIdentityGuardProtocol !== "presence-conflict-bit-v1") {
      throw new Error(
        `call ${callId} is missing the deferred identity-guard protocol`,
      );
    }
  });
  const staticSpecializedMeta = fnCtx.staticEffectContext
    ? getOrCreateStaticEffectSpecialization({
        ctx,
        meta,
        context: fnCtx.staticEffectContext,
      })
    : undefined;
  const callBaseMeta = staticSpecializedMeta ?? meta;
  const resolvedMeta =
    deferredIdentityGuards.length > 0
      ? getOrCreateDefaultIdentityGuardEntry({
          ctx,
          meta: callBaseMeta,
        })
      : callBaseMeta;
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
  const userArgOffsets: number[] = [];
  let nextUserArgOffset = 0;
  const userArgs = allArgs.flatMap((arg, index) => {
    userArgOffsets[index] = nextUserArgOffset;
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
    nextUserArgOffset += flattened.args.length;
    return flattened.args;
  });
  const argumentSetups: binaryen.ExpressionRef[] = [];
  const stabilizedBindings: ReturnType<typeof allocateTempLocal>[] = [];
  const stabilizedUserArgs =
    identityGuards.length === 0
      ? userArgs
      : userArgs.map((arg) => {
          const type = binaryen.getExpressionType(arg);
          const local = allocateTempLocal(type, fnCtx);
          stabilizedBindings.push(local);
          argumentSetups.push(ctx.mod.local.set(local.index, arg));
          return ctx.mod.local.get(local.index, type);
        });
  const identityOperandFor = ({
    parameter,
    identity,
    allocationPath,
  }: {
    parameter: number;
    identity: "allocation" | "storage" | "indexed-place";
    allocationPath?: readonly import("../../../semantics/codegen-view/index.js").CodegenPlaceProjection[];
  }): binaryen.ExpressionRef => {
    const offset = userArgOffsets[parameter];
    const binding =
      typeof offset === "number" ? stabilizedBindings[offset] : undefined;
    if (!binding) {
      throw new Error(
        `runtime identity guard is missing parameter ${parameter} at call ${callId}`,
      );
    }
    const operand = ctx.mod.local.get(binding.index, binding.type);
    if (identity === "storage") {
      return operand;
    }
    const allocationIdentity =
      resolvedMeta.paramAbiKinds[parameter] === "mutable_ref"
        ? liftHeapValueToInline({
            value: operand,
            typeId: resolvedMeta.paramTypeIds[parameter]!,
            ctx,
          })
        : operand;
    return identity === "allocation"
      ? projectRuntimeAllocationIdentity({
          allocation: allocationIdentity,
          typeId: resolvedMeta.paramTypeIds[parameter]!,
          path: allocationPath ?? [],
          context: `call ${callId}`,
          ctx,
        })
      : allocationIdentity;
  };
  const identityGuardOps = immediateIdentityGuards.map((guard) =>
    compileRuntimeIdentityGuard({
      left: runtimeIdentityForGuardOperand({
        operand: guard.left,
        allocation: identityOperandFor(guard.left),
        context: `call ${callId}`,
        ctx,
        fnCtx,
      }),
      right: runtimeIdentityForGuardOperand({
        operand: guard.right,
        allocation: identityOperandFor(guard.right),
        context: `call ${callId}`,
        ctx,
        fnCtx,
      }),
      leftDisplay: guard.left.display,
      rightDisplay: guard.right.display,
      context: `call ${callId}`,
      ctx,
    }),
  );
  const deferredIdentityGuardOps = deferredIdentityGuards.map((guard) => {
    if (
      typeof guard.diagnosticId !== "number" ||
      guard.diagnosticId < 1 ||
      guard.diagnosticId > 0x3fffffff
    ) {
      throw new Error(
        `runtime identity guard is missing a valid deferred diagnostic id at call ${callId}`,
      );
    }
    const omittedParameter = guard.omittedParameters[0];
    const parameterOffset =
      typeof omittedParameter === "number"
        ? userArgOffsets[omittedParameter]
        : undefined;
    const presenceOffset =
      typeof omittedParameter === "number"
        ? (resolvedMeta.paramAbiTypes[omittedParameter]?.length ?? 0) - 1
        : -1;
    const presenceBinding =
      typeof parameterOffset === "number" && presenceOffset >= 0
        ? stabilizedBindings[parameterOffset + presenceOffset]
        : undefined;
    if (!presenceBinding || presenceBinding.type !== binaryen.i32) {
      throw new Error(
        `runtime identity guard is missing an omitted-default presence lane at call ${callId}`,
      );
    }
    const context = `call ${callId}`;
    const conflict = compileRuntimeIdentityConflict({
      left: runtimeIdentityForGuardOperand({
        operand: guard.left,
        allocation: identityOperandFor(guard.left),
        context,
        ctx,
        fnCtx,
      }),
      right: runtimeIdentityForGuardOperand({
        operand: guard.right,
        allocation: identityOperandFor(guard.right),
        context,
        ctx,
        fnCtx,
      }),
      context,
      ctx,
    });
    const presenceValue = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(presenceBinding.index, binaryen.i32);
    const noConflictRecorded = ctx.mod.i32.eq(
      ctx.mod.i32.shr_u(presenceValue(), ctx.mod.i32.const(1)),
      ctx.mod.i32.const(0),
    );
    return ctx.mod.local.set(
      presenceBinding.index,
      ctx.mod.if(
        ctx.mod.i32.and(conflict, noConflictRecorded),
        ctx.mod.i32.or(
          presenceValue(),
          ctx.mod.i32.const(guard.diagnosticId << 1),
        ),
        presenceValue(),
      ),
    );
  });
  const preCallOps = [
    ...argSetups,
    ...argumentSetups,
    ...identityGuardOps,
    ...deferredIdentityGuardOps,
  ];
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
        ...(initializedWideResultStorage ? [initializedWideResultStorage] : []),
        ...stabilizedUserArgs,
      ]
    : [
        ...(initializedWideResultStorage ? [initializedWideResultStorage] : []),
        ...stabilizedUserArgs,
      ];

  if (resolvedMeta.effectful) {
    const rawCall = ctx.mod.call(
      resolvedMeta.wasmName,
      callArgs as number[],
      resolvedMeta.resultType,
    );
    const callExpr =
      preCallOps.length === 0
        ? rawCall
        : ctx.mod.block(
            null,
            [...preCallOps, rawCall],
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
    preCallOps.length === 0 &&
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
        intrinsicResultWasmType,
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
    const ops = preCallOps.length === 0 ? [rawCall] : [...preCallOps, rawCall];
    return {
      expr: ctx.mod.block(null, ops, binaryen.none),
      usedReturnCall: false,
      usedOutResultStorageRef: true,
    };
  }
  if (resolvedMeta.resultAbiKind === "out_ref" && wideResultStorage) {
    const reloaded = liftHeapValueToInline({
      value: ctx.mod.local.get(wideResultStorage.index, wideResultStorage.type),
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
      preCallOps.length === 0
        ? [
            rawCall,
            coerceExprToWasmType({
              expr: coerced,
              targetType: callResultWasmType,
              ctx,
            }),
          ]
        : [
            ...preCallOps,
            rawCall,
            coerceExprToWasmType({
              expr: coerced,
              targetType: callResultWasmType,
              ctx,
            }),
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
      preCallOps.length === 0
        ? stabilizedCall
        : ctx.mod.block(
            null,
            [...preCallOps, stabilizedCall],
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
    preCallOps.length === 0
      ? decodedCall
      : ctx.mod.block(
          null,
          [...preCallOps, decodedCall],
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
