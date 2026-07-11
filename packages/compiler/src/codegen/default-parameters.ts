import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  LocalBinding,
  LocalBindingLocal,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import {
  allocateAddressableLocal,
  allocateTempLocal,
  createStorageRefBinding,
  loadBindingStorageRef,
  loadBindingValue,
  storeLocalValue,
} from "./locals.js";
import { coerceValueToType } from "./structural.js";
import {
  getOptimizedParamAbiKind,
  getRequiredExprType,
  wasmTypeFor,
} from "./types.js";
import { compileOptionalNoneValue } from "./optionals.js";
import type { GroupContinuationCfg } from "./effects/continuation-cfg.js";

interface ContinuationDefaultInitialization {
  cfg: GroupContinuationCfg;
  compileExpr: ExpressionCompiler;
  startedLocal: LocalBindingLocal;
  activeSiteLocal: LocalBindingLocal;
}

export const compileDefaultParameterInitialization = ({
  fn,
  meta,
  ctx,
  fnCtx,
  continuation,
}: {
  fn: HirFunction;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  continuation?: ContinuationDefaultInitialization;
}): binaryen.ExpressionRef[] => {
  if (meta.callShape) {
    if (continuation) {
      throw new Error(
        "effectful default parameters do not support call-shape continuations",
      );
    }
    return compileCallShapeOmittedParameterInitialization({
      fn,
      meta,
      ctx,
      fnCtx,
    });
  }

  const ops: binaryen.ExpressionRef[] = [];
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;

  fn.parameters.forEach((param, index) => {
    if (typeof param.defaultValue !== "number") return;

    const typeId = meta.paramTypeIds[index];
    if (typeof typeId !== "number") {
      throw new Error(
        `codegen missing default parameter metadata for symbol ${param.symbol}`,
      );
    }

    const bindingKind = meta.parameters[index]?.bindingKind;
    const referenceBound = bindingKind !== undefined && bindingKind !== "value";
    const rawBinding = rawDefaultBinding({
      symbol: param.symbol,
      typeId,
      bindingKind,
      continuation: continuation !== undefined,
      ctx,
      fnCtx,
    });
    const present = defaultPresenceValue({
      parameterIndex: index,
      symbol: param.symbol,
      meta,
      continuation: continuation !== undefined,
      ctx,
      fnCtx,
    });

    const compileDefaultValue = (): binaryen.ExpressionRef => {
      const compiled = (continuation?.compileExpr ?? compileExpression)({
        exprId: param.defaultValue!,
        ctx,
        fnCtx,
        tailPosition: false,
        expectedResultTypeId: typeId,
      }).expr;
      const actualTypeId = getRequiredExprType(
        param.defaultValue!,
        ctx,
        typeInstanceId,
      );
      return coerceValueToType({
        value: compiled,
        actualType: actualTypeId,
        targetType: typeId,
        ctx,
        fnCtx,
      });
    };

    const usesStorageReference =
      referenceBound && loadBindingStorageRef(rawBinding, ctx) !== undefined;
    const { normalStore, resumedStore } = usesStorageReference
      ? compileReferenceDefaultStores({
          symbol: param.symbol,
          typeId,
          mutable: bindingKind === "mutable-ref",
          rawBinding,
          present,
          compileDefaultValue,
          ctx,
          fnCtx,
        })
      : compileValueDefaultStores({
          symbol: param.symbol,
          typeId,
          rawBinding,
          present,
          compileDefaultValue,
          ctx,
          fnCtx,
        });

    if (!continuation) {
      ops.push(normalStore);
      return;
    }

    const sites = continuation.cfg.sitesByExpr.get(param.defaultValue);
    const activeInDefault = [...(sites ?? [])]
      .map((siteOrder) =>
        ctx.mod.i32.eq(
          ctx.mod.local.get(
            continuation.activeSiteLocal.index,
            continuation.activeSiteLocal.type,
          ),
          ctx.mod.i32.const(siteOrder),
        ),
      )
      .reduce(
        (acc, comparison) => ctx.mod.i32.or(acc, comparison),
        ctx.mod.i32.const(0),
      );
    const started = () =>
      ctx.mod.local.get(
        continuation.startedLocal.index,
        continuation.startedLocal.type,
      );
    const resumeCurrent = ctx.mod.i32.and(
      ctx.mod.i32.eqz(started()),
      activeInDefault,
    );
    ops.push(
      ctx.mod.if(
        resumeCurrent,
        resumedStore,
        ctx.mod.if(started(), normalStore, ctx.mod.nop()),
      ),
    );
  });

  return ops;
};

const rawDefaultBinding = ({
  symbol,
  typeId,
  bindingKind,
  continuation,
  ctx,
  fnCtx,
}: {
  symbol: number;
  typeId: number;
  bindingKind: string | undefined;
  continuation: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBinding => {
  const temp = continuation
    ? ctx.effectLowering.defaultParamTemps.get(symbol)
    : undefined;
  const tempBinding = temp ? fnCtx.tempLocals.get(temp.tempId) : undefined;
  if (temp && tempBinding) {
    const storageRef =
      bindingKind !== undefined && bindingKind !== "value"
        ? getOptimizedParamAbiKind({ typeId, bindingKind, ctx }) !== "direct"
        : temp.storageRef;
    return storageRef
      ? createStorageRefBinding({
          index: tempBinding.index,
          typeId,
          mutable: bindingKind === "mutable-ref",
          ctx,
        })
      : tempBinding;
  }
  const binding = fnCtx.bindings.get(symbol);
  if (!binding) {
    throw new Error(`codegen missing raw default parameter ${symbol}`);
  }
  return binding;
};

const defaultPresenceValue = ({
  parameterIndex,
  symbol,
  meta,
  continuation,
  ctx,
  fnCtx,
}: {
  parameterIndex: number;
  symbol: number;
  meta: FunctionMetadata;
  continuation: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (continuation) {
    const temp = ctx.effectLowering.defaultParamTemps.get(symbol);
    const binding = temp
      ? fnCtx.tempLocals.get(temp.presenceTempId)
      : undefined;
    if (!binding) {
      throw new Error(`codegen missing default presence temp for ${symbol}`);
    }
    return loadBindingValue(binding, ctx, fnCtx);
  }
  const index =
    meta.firstUserParamIndex +
    meta.paramAbiTypes
      .slice(0, parameterIndex)
      .reduce((sum, types) => sum + types.length, 0) +
    (meta.paramAbiTypes[parameterIndex]?.length ?? 0) -
    1;
  return ctx.mod.local.get(index, binaryen.i32);
};

const compileValueDefaultStores = ({
  symbol,
  typeId,
  rawBinding,
  present,
  compileDefaultValue,
  ctx,
  fnCtx,
}: {
  symbol: number;
  typeId: number;
  rawBinding: LocalBinding;
  present: binaryen.ExpressionRef;
  compileDefaultValue: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  normalStore: binaryen.ExpressionRef;
  resumedStore: binaryen.ExpressionRef;
} => {
  const resolved = allocateTempLocal(
    wasmTypeFor(typeId, ctx),
    fnCtx,
    typeId,
    ctx,
  );
  fnCtx.bindings.set(symbol, resolved);
  return {
    normalStore: storeLocalValue({
      binding: resolved,
      value: ctx.mod.if(
        present,
        loadBindingValue(rawBinding, ctx, fnCtx),
        compileDefaultValue(),
      ),
      ctx,
      fnCtx,
    }),
    resumedStore: storeLocalValue({
      binding: resolved,
      value: compileDefaultValue(),
      ctx,
      fnCtx,
    }),
  };
};

const compileReferenceDefaultStores = ({
  symbol,
  typeId,
  mutable,
  rawBinding,
  present,
  compileDefaultValue,
  ctx,
  fnCtx,
}: {
  symbol: number;
  typeId: number;
  mutable: boolean;
  rawBinding: LocalBinding;
  present: binaryen.ExpressionRef;
  compileDefaultValue: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  normalStore: binaryen.ExpressionRef;
  resumedStore: binaryen.ExpressionRef;
} => {
  const suppliedStorage = loadBindingStorageRef(rawBinding, ctx);
  if (!suppliedStorage) {
    throw new Error("reference default payload requires a storage reference");
  }
  const defaultStorage = allocateAddressableLocal({ typeId, ctx, fnCtx });
  const defaultStorageRef = loadBindingStorageRef(defaultStorage, ctx);
  if (!defaultStorageRef) {
    throw new Error("reference default requires addressable local storage");
  }
  const selectedStorage = allocateTempLocal(rawBinding.storageType, fnCtx);
  fnCtx.bindings.set(
    symbol,
    createStorageRefBinding({
      index: selectedStorage.index,
      typeId,
      mutable,
      ctx,
    }),
  );
  const initializeDefault = (): binaryen.ExpressionRef =>
    ctx.mod.block(
      null,
      [
        storeLocalValue({
          binding: defaultStorage,
          value: compileDefaultValue(),
          ctx,
          fnCtx,
        }),
        defaultStorageRef,
      ],
      defaultStorage.storageType,
    );
  return {
    normalStore: storeLocalValue({
      binding: selectedStorage,
      value: ctx.mod.if(present, suppliedStorage, initializeDefault()),
      ctx,
      fnCtx,
    }),
    resumedStore: storeLocalValue({
      binding: selectedStorage,
      value: initializeDefault(),
      ctx,
      fnCtx,
    }),
  };
};

const compileCallShapeOmittedParameterInitialization = ({
  fn,
  meta,
  ctx,
  fnCtx,
}: {
  fn: HirFunction;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  const ops: binaryen.ExpressionRef[] = [];
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;

  fn.parameters.forEach((parameter, index) => {
    if (meta.callShape?.parameterStates[index] !== "omitted") return;
    const targetTypeId = meta.paramTypeIds[index];
    if (typeof targetTypeId !== "number") {
      throw new Error(
        `codegen missing call-shape parameter type for symbol ${parameter.symbol}`,
      );
    }
    const value =
      typeof parameter.defaultValue === "number"
        ? (() => {
            const compiled = compileExpression({
              exprId: parameter.defaultValue,
              ctx,
              fnCtx,
              tailPosition: false,
              expectedResultTypeId: targetTypeId,
            }).expr;
            const actualTypeId = getRequiredExprType(
              parameter.defaultValue,
              ctx,
              typeInstanceId,
            );
            return coerceValueToType({
              value: compiled,
              actualType: actualTypeId,
              targetType: targetTypeId,
              ctx,
              fnCtx,
            });
          })()
        : compileOptionalNoneValue({ targetTypeId, ctx, fnCtx });
    const bindingKind = meta.parameters[index]?.bindingKind;
    const referenceBound = bindingKind !== undefined && bindingKind !== "value";
    const binding = referenceBound
      ? allocateAddressableLocal({ typeId: targetTypeId, ctx, fnCtx })
      : allocateTempLocal(
          wasmTypeFor(targetTypeId, ctx),
          fnCtx,
          targetTypeId,
          ctx,
        );
    fnCtx.bindings.set(parameter.symbol, binding);
    ops.push(storeLocalValue({ binding, value, ctx, fnCtx }));
  });

  return ops;
};
