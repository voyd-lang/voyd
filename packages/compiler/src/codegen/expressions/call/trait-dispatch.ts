import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  SymbolId,
  TypeId,
} from "../../context.js";
import {
  callRef,
  initDefaultStruct,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_METHOD_ACCESSOR, RTT_METADATA_SLOTS } from "../../rtt/index.js";
import { traitDispatchHash } from "../../trait-dispatch-key.js";
import {
  isTraitDispatchMethodEffectful,
  resolveImportedFunctionSymbol,
} from "../../trait-dispatch-abi.js";
import {
  getExprBinaryenType,
  getFunctionRefType,
  getRequiredExprType,
  getSignatureSpillBoxType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../../types.js";
import { allocateTempLocal } from "../../locals.js";
import { getFunctionMetadataForCall } from "./metadata.js";
import { pickTraitImplMethodMeta } from "../../function-lookup.js";
import {
  compileCallArgumentsForParams,
  resolveTypedCallArgumentPlan,
  sliceTypedCallArgumentPlan,
} from "./arguments.js";
import {
  currentHandlerValue,
  handlerType,
} from "./shared.js";
import { coerceValueToType } from "../../structural.js";
import {
  liftHeapValueToInline,
} from "../../structural.js";
import { coerceExprToWasmType } from "../../wasm-type-coercions.js";
import { typeContainsUnresolvedParam } from "../../../semantics/type-utils.js";
import type { CodegenTraitImplInstance } from "../../../semantics/codegen-view/index.js";
import type { ProgramSymbolId } from "../../../semantics/ids.js";
import type { FunctionMetadata } from "../../context.js";
import { captureMultivalueLanes } from "../../multivalue.js";
import {
  boxSignatureSpillValue,
  unboxSignatureSpillValue,
} from "../../signature-spill.js";

const MAX_DIRECT_TRAIT_SWITCH_IMPLS = 4;

const stabilizeMultivalueResult = ({
  value,
  abiTypes,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
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
  return ctx.mod.block(
    null,
    [...captured.setup, tuple],
    binaryen.createType(abiTypes as number[]),
  );
};

const flattenTraitDispatchArgument = ({
  value,
  abiTypes,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  args: readonly binaryen.ExpressionRef[];
} => {
  if (
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

type DirectTraitDispatchCandidate = {
  meta: FunctionMetadata;
  runtimeTypeId: number;
  wrapperName: string;
};

const resolveDirectTraitDispatchCandidate = ({
  impl,
  mapping,
  ctx,
}: {
  impl: CodegenTraitImplInstance;
  mapping: NonNullable<ReturnType<CodegenContext["program"]["traits"]["getTraitMethodImpl"]>>;
  ctx: CodegenContext;
}): DirectTraitDispatchCandidate | undefined => {
  if (
    typeContainsUnresolvedParam({
      typeId: impl.target,
      getTypeDesc: (typeId) => ctx.program.types.getTypeDesc(typeId),
    }) ||
    typeContainsUnresolvedParam({
      typeId: impl.trait,
      getTypeDesc: (typeId) => ctx.program.types.getTypeDesc(typeId),
    })
  ) {
    return undefined;
  }

  const structInfo = getStructuralTypeInfo(impl.target, ctx);
  if (!structInfo) {
    return undefined;
  }

  const method = impl.methods.find(({ traitMethod, implMethod }) => {
    const traitMethodImpl = ctx.program.traits.getTraitMethodImpl(
      implMethod as ProgramSymbolId,
    );
    const mappedTraitSymbol = traitMethodImpl?.traitSymbol ?? impl.traitSymbol;
    const mappedTraitMethod = traitMethodImpl?.traitMethodSymbol ?? traitMethod;
    return (
      mappedTraitSymbol === mapping.traitSymbol &&
      mappedTraitMethod === mapping.traitMethodSymbol
    );
  });
  if (!method) {
    return undefined;
  }

  const implRef = ctx.program.symbols.refOf(method.implMethod as ProgramSymbolId);
  const resolvedImplRef = resolveImportedFunctionSymbol({
    ctx,
    moduleId: implRef.moduleId,
    symbol: implRef.symbol,
  });
  const metas = ctx.functions
    .get(resolvedImplRef.moduleId)
    ?.get(resolvedImplRef.symbol);
  const meta = pickTraitImplMethodMeta({
    metas,
    impl,
    runtimeType: ctx.rtt.baseType,
    ctx,
  });
  if (!meta || meta.effectful) {
    return undefined;
  }

  return {
    meta,
    runtimeTypeId: structInfo.runtimeTypeId,
    wrapperName: `${structInfo.typeLabel}__method_${mapping.traitSymbol}_${mapping.traitMethodSymbol}_${method.implMethod}`,
  };
};

const compileDirectTraitDispatchSwitch = ({
  expr,
  meta,
  mapping,
  resolvedModuleId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  meta: FunctionMetadata;
  mapping: NonNullable<ReturnType<CodegenContext["program"]["traits"]["getTraitMethodImpl"]>>;
  resolvedModuleId: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (meta.effectful || resolvedModuleId !== ctx.moduleId) {
    return undefined;
  }

  if (
    isTraitDispatchMethodEffectful({
      traitSymbol: mapping.traitSymbol,
      traitMethodSymbol: mapping.traitMethodSymbol,
      ctx,
    })
  ) {
    return undefined;
  }

  const impls = ctx.program.traits.getImplsByTrait(mapping.traitSymbol);
  if (impls.length === 0 || impls.length > MAX_DIRECT_TRAIT_SWITCH_IMPLS) {
    return undefined;
  }

  let exhaustive = true;
  const candidates = impls.flatMap((impl) => {
    const candidate = resolveDirectTraitDispatchCandidate({ impl, mapping, ctx });
    if (!candidate) {
      exhaustive = false;
      return [];
    }
    return [candidate];
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  if (
    ctx.program.types.getTypeDesc(returnTypeId).kind !== "primitive" ||
    binaryen.expandType(resultWasmType).length !== 1
  ) {
    return undefined;
  }

  const baselineUserParamTypes = meta.paramTypes.slice(meta.firstUserParamIndex + 1);
  if (baselineUserParamTypes.length !== 0) {
    return undefined;
  }
  const consistentUserParams = candidates.every((candidate) => {
    const candidateUserParamTypes = candidate.meta.paramTypes.slice(
      candidate.meta.firstUserParamIndex + 1,
    );
    return (
      candidateUserParamTypes.length === baselineUserParamTypes.length &&
      candidateUserParamTypes.every((type, index) => type === baselineUserParamTypes[index])
    );
  });
  if (!consistentUserParams) {
    return undefined;
  }

  const typedPlan = resolveTypedCallArgumentPlan({
    callId: expr.id,
    typeInstanceId,
    ctx,
  });
  let userTypedPlan: ReturnType<typeof resolveTypedCallArgumentPlan>;
  if (typedPlan !== undefined) {
    const resolvedTypedPlan =
      typedPlan as NonNullable<ReturnType<typeof resolveTypedCallArgumentPlan>>;
    userTypedPlan = sliceTypedCallArgumentPlan({
      typedPlan: resolvedTypedPlan,
      paramOffset: 1,
      argOffset: 1,
    });
  }
  const receiverValue = compileExpr({
    exprId: expr.args[0]!.expr,
    ctx,
    fnCtx,
  });
  const receiverTemp = allocateTempLocal(ctx.rtt.baseType, fnCtx);
  const userArgValues = compileCallArgumentsForParams({
    call: { ...expr, args: expr.args.slice(1) },
    params: meta.parameters.slice(1),
    ctx,
    fnCtx,
    compileExpr,
    options: {
      typeInstanceId,
      argIndexOffset: 1,
      allCallArgExprIds: expr.args.map((arg) => arg.expr),
      typedPlan: userTypedPlan,
    },
  });
  const userArgTemps = baselineUserParamTypes.map((type) =>
    allocateTempLocal(type, fnCtx),
  );

  const makeReceiver = () => ctx.mod.local.get(receiverTemp.index, receiverTemp.type);
  const makeAncestors = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldType: ctx.rtt.extensionHelpers.i32Array,
      fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
      exprRef: makeReceiver(),
    });

  const emitCandidateCall = (
    candidate: DirectTraitDispatchCandidate,
  ): binaryen.ExpressionRef => {
    const rawCall = ctx.mod.call(
      candidate.wrapperName,
      [
        makeReceiver(),
        ...userArgTemps.map((temp) => ctx.mod.local.get(temp.index, temp.type)),
      ],
      candidate.meta.resultType,
    );
    const coerced =
      candidate.meta.resultTypeId === returnTypeId
        ? rawCall
        : coerceValueToType({
            value: rawCall,
            actualType: candidate.meta.resultTypeId,
            targetType: returnTypeId,
            ctx,
            fnCtx,
          });
    return coerceExprToWasmType({
      expr: coerced,
      targetType: resultWasmType,
      ctx,
    });
  };

  const fallback = compileIndirectTraitDispatchCall({
    expr,
    meta,
    mapping,
    receiverTemp,
    userArgTemps,
    ctx,
    fnCtx,
    compileExpr,
  });

  const fallbackExpr =
    exhaustive && candidates.length > 0
      ? emitCandidateCall(candidates[candidates.length - 1]!)
      : fallback.expr;
  const branchCandidates =
    exhaustive && candidates.length > 0 ? candidates.slice(0, -1) : candidates;
  const switchedExpr = branchCandidates.reduceRight(
    (current, candidate) =>
      ctx.mod.if(
        ctx.mod.call(
          "__has_type",
          [ctx.mod.i32.const(candidate.runtimeTypeId), makeAncestors()],
          binaryen.i32,
        ),
        emitCandidateCall(candidate),
        current,
      ),
    fallbackExpr,
  );

  return {
    expr: ctx.mod.block(
      null,
      [
        ctx.mod.local.set(receiverTemp.index, receiverValue.expr),
        ...userArgTemps.map((temp, index) =>
          ctx.mod.local.set(temp.index, userArgValues[index]!),
        ),
        switchedExpr,
      ],
      resultWasmType,
    ),
    usedReturnCall: false,
  };
};

export const compileTraitDispatchCall = ({
  expr,
  calleeSymbol,
  calleeModuleId,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
  outResultStorageRef,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
  outResultStorageRef?: binaryen.ExpressionRef;
}): CompiledExpression | undefined => {
  if (expr.args.length === 0) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const resolvedModuleId = calleeModuleId ?? ctx.moduleId;
  const mapping = ctx.program.traits.getTraitMethodImpl(
    ctx.program.symbols.canonicalIdOf(resolvedModuleId, calleeSymbol)
  );
  if (!mapping) {
    return undefined;
  }

  const receiverTypeId = getRequiredExprType(
    expr.args[0].expr,
    ctx,
    typeInstanceId
  );
  const receiverDesc = ctx.program.types.getTypeDesc(receiverTypeId);
  const receiverTraitSymbol =
    receiverDesc.kind === "trait" ? receiverDesc.owner : undefined;

  if (receiverDesc.kind !== "trait" || receiverTraitSymbol !== mapping.traitSymbol) {
    return undefined;
  }

  const meta = getFunctionMetadataForCall({
    symbol: calleeSymbol,
    callId: expr.id,
    ctx,
    moduleId: resolvedModuleId,
    typeInstanceId,
  });
  if (!meta) {
    return undefined;
  }

  const directDispatch = compileDirectTraitDispatchSwitch({
    expr,
    meta,
    mapping,
    resolvedModuleId,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (directDispatch) {
    return directDispatch;
  }

  return compileIndirectTraitDispatchCall({
    expr,
    meta,
    mapping,
    ctx,
    fnCtx,
    compileExpr,
    tailPosition,
    expectedResultTypeId,
    outResultStorageRef,
  });
};

const compileIndirectTraitDispatchCall = ({
  expr,
  meta,
  mapping,
  receiverTemp,
  userArgTemps,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition = false,
  expectedResultTypeId,
  outResultStorageRef,
}: {
  expr: HirCallExpr;
  meta: FunctionMetadata;
  mapping: NonNullable<ReturnType<CodegenContext["program"]["traits"]["getTraitMethodImpl"]>>;
  receiverTemp?: { index: number; type: binaryen.Type };
  userArgTemps?: readonly { index: number; type: binaryen.Type }[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition?: boolean;
  expectedResultTypeId?: TypeId;
  outResultStorageRef?: binaryen.ExpressionRef;
}): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const receiverValue = receiverTemp
    ? undefined
    : compileExpr({
        exprId: expr.args[0].expr,
        ctx,
        fnCtx,
      });
  const resolvedReceiverTemp = receiverTemp ?? allocateTempLocal(ctx.rtt.baseType, fnCtx);
  const ops: binaryen.ExpressionRef[] = receiverValue
    ? [ctx.mod.local.set(resolvedReceiverTemp.index, receiverValue.expr)]
    : [];

  const loadReceiver = (): binaryen.ExpressionRef =>
    ctx.mod.local.get(resolvedReceiverTemp.index, resolvedReceiverTemp.type);

  const receiverIndex = meta.firstUserParamIndex;
  const userParamTypes = meta.paramTypes.slice(receiverIndex + 1);
  const dispatchEffectful =
    meta.effectful ||
    isTraitDispatchMethodEffectful({
      traitSymbol: mapping.traitSymbol,
      traitMethodSymbol: mapping.traitMethodSymbol,
      ctx,
    });
  const outParamTypes =
    meta.resultAbiKind === "out_ref" && typeof meta.outParamType === "number"
      ? [meta.outParamType]
      : [];
  const wrapperParamTypes = dispatchEffectful
    ? [handlerType(ctx), ...outParamTypes, ctx.rtt.baseType, ...userParamTypes]
    : [...outParamTypes, ctx.rtt.baseType, ...userParamTypes];
  const fnRefType = getFunctionRefType({
    params: wrapperParamTypes,
    result: dispatchEffectful
      ? ctx.effectsBackend.abi.effectfulResultType(ctx)
      : meta.resultAbiKind === "out_ref"
        ? binaryen.none
        : meta.resultType,
    ctx,
    label: "trait_method",
  });
  const methodTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.methodLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.METHOD_TABLE,
    exprRef: loadReceiver(),
  });

  const accessor = ctx.mod.call(
    LOOKUP_METHOD_ACCESSOR,
    [
      ctx.mod.i32.const(
        traitDispatchHash({
          traitSymbol: mapping.traitSymbol,
          traitMethodSymbol: mapping.traitMethodSymbol,
        })
      ),
      methodTable,
    ],
    binaryen.funcref
  );

  const target = refCast(ctx.mod, accessor, fnRefType);
  const typedPlan = resolveTypedCallArgumentPlan({
    callId: expr.id,
    typeInstanceId,
    ctx,
  });
  const allCallArgExprIds = expr.args.map((arg) => arg.expr);
  const userTypedPlan = typedPlan
    ? sliceTypedCallArgumentPlan({
        typedPlan,
        paramOffset: 1,
        argOffset: 1,
      })
    : undefined;
  const compiledUserArgs = userArgTemps
    ? userArgTemps.map((temp) => ctx.mod.local.get(temp.index, temp.type))
    : compileCallArgumentsForParams({
        call: { ...expr, args: expr.args.slice(1) },
        params: meta.parameters.slice(1),
        ctx,
        fnCtx,
        compileExpr,
        options: {
          typeInstanceId,
          argIndexOffset: 1,
          allCallArgExprIds,
          typedPlan: userTypedPlan,
        },
      });
  const argSetups: binaryen.ExpressionRef[] = [];
  const flattenedUserArgs = compiledUserArgs.flatMap((arg, index) => {
    const flattened = flattenTraitDispatchArgument({
      value: arg,
      abiTypes: meta.paramAbiTypes[index + 1] ?? [binaryen.getExpressionType(arg)],
      typeId: meta.paramTypeIds[index + 1]!,
      ctx,
      fnCtx,
    });
    argSetups.push(...flattened.setup);
    return flattened.args;
  });
  const usingProvidedWideResultStorage =
    !dispatchEffectful &&
    meta.resultAbiKind === "out_ref" &&
    typeof outResultStorageRef === "number";
  const wideResultStorage =
    meta.resultAbiKind === "out_ref"
      ? (() => {
          if (usingProvidedWideResultStorage) {
            return undefined;
          }
          if (typeof meta.outParamType !== "number") {
            throw new Error("trait dispatch out_ref result is missing storage metadata");
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
  const args = [loadReceiver(), ...flattenedUserArgs];

  const callArgs = dispatchEffectful
    ? [currentHandlerValue(ctx, fnCtx), ...(initializedWideResultStorage ? [initializedWideResultStorage] : []), ...args]
    : [...(initializedWideResultStorage ? [initializedWideResultStorage] : []), ...args];
  const rawCall = callRef(
    ctx.mod,
    target,
    callArgs as number[],
    dispatchEffectful
      ? ctx.effectsBackend.abi.effectfulResultType(ctx)
      : meta.resultAbiKind === "out_ref"
        ? binaryen.none
        : meta.resultType
  );
  const stabilizedCall = dispatchEffectful
    ? rawCall
    : stabilizeMultivalueResult({
        value: rawCall,
        abiTypes: meta.resultAbiTypes,
        ctx,
        fnCtx,
      });
  const decodedCall =
    !dispatchEffectful &&
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

  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const resultWasmType = wasmTypeFor(expectedTypeId, ctx);
  const lowered: CompiledExpression = dispatchEffectful
    ? ctx.effectsBackend.lowerEffectfulCallResult({
        callExpr,
        callId: expr.id,
        returnTypeId,
        expectedResultTypeId,
        tailPosition,
        typeInstanceId,
        ctx,
        fnCtx,
      })
    : usingProvidedWideResultStorage
      ? {
          expr:
            argSetups.length === 0
              ? ctx.mod.block(null, [rawCall], binaryen.none)
              : ctx.mod.block(null, [...argSetups, rawCall], binaryen.none),
          usedReturnCall: false,
          usedOutResultStorageRef: true,
        }
    : meta.resultAbiKind === "out_ref" && wideResultStorage
      ? (() => {
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
          const resultExpr = coerceExprToWasmType({
            expr: coerced,
            targetType: resultWasmType,
            ctx,
          });
          return {
            expr:
              argSetups.length === 0
                ? ctx.mod.block(null, [rawCall, resultExpr], resultWasmType)
                : ctx.mod.block(
                    null,
                    [...argSetups, rawCall, resultExpr],
                    resultWasmType,
                  ),
            usedReturnCall: false,
          };
        })()
    : {
        expr: coerceExprToWasmType({
          expr:
            meta.resultTypeId === expectedTypeId
              ? callExpr
              : coerceValueToType({
                  value: callExpr,
                  actualType: meta.resultTypeId,
                  targetType: expectedTypeId,
                  ctx,
                  fnCtx,
                }),
          targetType: resultWasmType,
          ctx,
        }),
        usedReturnCall: false,
      };

  ops.push(lowered.expr);
  const binaryenResult = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  return {
    expr: ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryenResult),
    usedReturnCall: lowered.usedReturnCall,
    usedOutResultStorageRef: lowered.usedOutResultStorageRef,
  };
};
