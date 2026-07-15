import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  TypeId,
} from "./context.js";
import type { ProgramFunctionInstanceId } from "../semantics/ids.js";
import {
  getClosureTypeInfo,
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getFixedArrayWasmTypes,
  wasmTypeFor,
} from "./types.js";
import { allocateTempLocal } from "./locals.js";
import {
  coerceValueToType,
  defaultFixedArrayElementValue,
  fixedArrayStorageElementType,
  liftFixedArrayElementValue,
  loadStructuralField,
  lowerFixedArrayElementValue,
} from "./structural.js";
import {
  arrayCopy,
  arrayGet,
  arrayLen,
  arrayNew,
  arrayNewFixed,
  arraySet,
  callRef,
  modBinaryenTypeToHeapType,
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { HeapTypeRef } from "@voyd-lang/lib/binaryen-gc/types.js";
import { LINEAR_MEMORY_INTERNAL } from "./effects/host-boundary/constants.js";
import { ensureDispatcher } from "./effects/dispatcher.js";
import { ensureMsgPackFunctions } from "./effects/host-boundary/msgpack.js";
import {
  unboxOutcomeValue,
  wrapValueInOutcome,
} from "./effects/outcome-values.js";
import {
  lowerSerializedAbiArg,
  stabilizeSerializedAbiResult,
} from "./exports/serialized-abi.js";
import { ensureLinearMemoryExport } from "./memory-exports.js";
import { deriveBoundarySchema } from "./boundary/schema.js";
import {
  packBoundaryValueAsMsgPack,
  unpackBoundaryValueFromMsgPack,
} from "./boundary/msgpack-codec.js";
import { findSerializerForType } from "./serializer.js";
import { stableCallsiteIdFor } from "../stable-callsite-id.js";
import {
  boundaryMsgPackPayloadField,
  isBoundaryMsgPackValue,
} from "./boundary-metadata.js";
import { currentHandlerValue } from "./expressions/call/shared.js";
import { compileExternalCall } from "./external/imports.js";

type NumericKind = "i32" | "i64" | "f32" | "f64";
type EqualityKind = NumericKind | "bool";
type BooleanKind = "bool";
type IntegerKind = "i32" | "i64";
type FloatKind = "f32" | "f64";
type WasmFloatUnaryIntrinsicOp =
  | "__floor"
  | "__ceil"
  | "__round"
  | "__trunc"
  | "__sqrt";

interface CompileIntrinsicCallParams {
  name: string;
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceId?: ProgramFunctionInstanceId;
  paramTypeIds?: readonly TypeId[];
  externalIdentity?: { interfaceId: string; functionName: string };
}

interface EmitNumericIntrinsicParams {
  kind: NumericKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

interface EmitEqualityIntrinsicParams {
  op: "==" | "!=";
  kind: EqualityKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}

interface EmitFloatUnaryIntrinsicParams {
  op: WasmFloatUnaryIntrinsicOp;
  kind: FloatKind;
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}

const PANIC_TRAP_PTR_GLOBAL = "__voyd_panic_ptr";
const PANIC_TRAP_LEN_GLOBAL = "__voyd_panic_len";
const PANIC_SCRATCH_PTR_GLOBAL = "__voyd_panic_scratch_ptr";
const PANIC_SCRATCH_CAPACITY_GLOBAL = "__voyd_panic_scratch_capacity";
const TASK_IMPORT_MODULE = "voyd.task";
const TASK_IMPORTS_KEY = Symbol("voyd.task.imports");
const TASK_STARTERS_KEY = Symbol("voyd.task.starters");
const CALLBACK_IMPORT_MODULE = "voyd.callback";
const CALLBACK_IMPORTS_KEY = Symbol("voyd.callback.imports");
const CALLBACK_HELPERS_KEY = Symbol("voyd.callback.helpers");
export const EFFECTFUL_RETAINED_CALLBACK_TARGETS_KEY = Symbol(
  "voyd.effectfulRetainedCallbackTargets",
);
const BOUNDARY_CALLBACK_IMPORT_MODULE = "voyd.boundary.callback";
const BOUNDARY_CALLBACK_IMPORTS_KEY = Symbol("voyd.boundary.callback.imports");
const RENDER_CALLBACK_IMPORT_MODULE = "voyd.render.callback";
const RENDER_CALLBACK_IMPORTS_KEY = Symbol("voyd.render.callback.imports");
const CALLBACK_SCOPE_IMPORT_MODULE = "voyd.callback.scope";
const CALLBACK_SCOPE_IMPORTS_KEY = Symbol("voyd.callback.scope.imports");

const ensurePanicTrapGlobals = (ctx: CodegenContext): void => {
  if (ctx.mod.getGlobal(PANIC_TRAP_PTR_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_TRAP_PTR_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(-1),
    );
    ctx.mod.addGlobalExport(PANIC_TRAP_PTR_GLOBAL, PANIC_TRAP_PTR_GLOBAL);
  }
  if (ctx.mod.getGlobal(PANIC_TRAP_LEN_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_TRAP_LEN_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0),
    );
    ctx.mod.addGlobalExport(PANIC_TRAP_LEN_GLOBAL, PANIC_TRAP_LEN_GLOBAL);
  }
  if (ctx.mod.getGlobal(PANIC_SCRATCH_PTR_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_SCRATCH_PTR_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(-1),
    );
  }
  if (ctx.mod.getGlobal(PANIC_SCRATCH_CAPACITY_GLOBAL) === 0) {
    ctx.mod.addGlobal(
      PANIC_SCRATCH_CAPACITY_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0),
    );
  }
};

const sanitizeTaskKey = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const ensureTaskImport = ({
  name,
  base,
  params,
  result,
  ctx,
}: {
  name: string;
  base: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    TASK_IMPORTS_KEY,
    () => new Set<string>(),
  );
  if (imports.has(name)) {
    return name;
  }
  ctx.mod.addFunctionImport(
    name,
    TASK_IMPORT_MODULE,
    base,
    binaryen.createType(params as number[]),
    result,
  );
  imports.add(name);
  return name;
};

const ensureCallbackImport = ({
  name,
  base,
  params,
  result,
  ctx,
}: {
  name: string;
  base: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    CALLBACK_IMPORTS_KEY,
    () => new Set<string>(),
  );
  if (imports.has(name)) {
    return name;
  }
  ctx.mod.addFunctionImport(
    name,
    CALLBACK_IMPORT_MODULE,
    base,
    binaryen.createType(params as number[]),
    result,
  );
  imports.add(name);
  return name;
};

const ensureBoundaryCallbackImport = ({
  name,
  base,
  params,
  result,
  ctx,
}: {
  name: string;
  base: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    BOUNDARY_CALLBACK_IMPORTS_KEY,
    () => new Set<string>(),
  );
  if (imports.has(name)) {
    return name;
  }
  ctx.mod.addFunctionImport(
    name,
    BOUNDARY_CALLBACK_IMPORT_MODULE,
    base,
    binaryen.createType(params as number[]),
    result,
  );
  imports.add(name);
  return name;
};

const ensureRenderCallbackImport = ({
  name,
  base,
  params,
  result,
  ctx,
}: {
  name: string;
  base: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    RENDER_CALLBACK_IMPORTS_KEY,
    () => new Set<string>(),
  );
  if (imports.has(name)) {
    return name;
  }
  ctx.mod.addFunctionImport(
    name,
    RENDER_CALLBACK_IMPORT_MODULE,
    base,
    binaryen.createType(params as number[]),
    result,
  );
  imports.add(name);
  return name;
};

const ensureCallbackScopeImport = ({
  name,
  base,
  params,
  result,
  ctx,
}: {
  name: string;
  base: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): string => {
  const imports = ctx.programHelpers.getHelperState(
    CALLBACK_SCOPE_IMPORTS_KEY,
    () => new Set<string>(),
  );
  if (imports.has(name)) {
    return name;
  }
  ctx.mod.addFunctionImport(
    name,
    CALLBACK_SCOPE_IMPORT_MODULE,
    base,
    binaryen.createType(params as number[]),
    result,
  );
  imports.add(name);
  return name;
};

export const compileBeginRetainedCallbackScope = (
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  const importFn = ensureCallbackScopeImport({
    name: "__voyd_begin_retained_callback_scope",
    base: "begin",
    params: [],
    result: binaryen.i32,
    ctx,
  });
  return ctx.mod.call(importFn, [], binaryen.i32);
};

export const compileEndRetainedCallbackScope = ({
  scopeId,
  ctx,
}: {
  scopeId: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const importFn = ensureCallbackScopeImport({
    name: "__voyd_end_retained_callback_scope",
    base: "end",
    params: [binaryen.i32],
    result: binaryen.none,
    ctx,
  });
  return ctx.mod.call(importFn, [scopeId], binaryen.none);
};

const ensureTaskStarterHelper = ({
  closureTypeId,
  ctx,
}: {
  closureTypeId: TypeId;
  ctx: CodegenContext;
}): string => {
  const starters = ctx.programHelpers.getHelperState(
    TASK_STARTERS_KEY,
    () => new Map<number, string>(),
  );
  const cached = starters.get(closureTypeId);
  if (cached) {
    return cached;
  }

  const desc = ctx.program.types.getTypeDesc(closureTypeId);
  if (desc.kind !== "function") {
    throw new Error("task spawn requires a function-typed work value");
  }
  if (desc.parameters.length !== 0) {
    throw new Error("task spawn only supports zero-argument work functions");
  }

  const base = getClosureTypeInfo(closureTypeId, ctx);
  const effectful =
    typeof desc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(desc.effectRow);
  const exportName = `__voyd_task_start_${sanitizeTaskKey(base.key)}`;
  const hiddenParamTypes = base.paramTypes.slice(0, base.userParamOffset);
  const params = binaryen.createType([base.interfaceType, ...hiddenParamTypes]);
  const helperFnCtx = {
    locals: [] as binaryen.Type[],
    nextLocalIndex: 1,
  };
  const closureRef = ctx.mod.local.get(0, base.interfaceType);
  const fnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: closureRef,
  });
  const targetFn =
    base.fnRefType === binaryen.funcref
      ? fnField
      : refCast(ctx.mod, fnField, base.fnRefType);
  const callArgs = [
    closureRef,
    ...hiddenParamTypes.map((type, index) =>
      ctx.mod.local.get(index + 1, type),
    ),
  ];
  const callExpr = callRef(
    ctx.mod,
    targetFn,
    callArgs as number[],
    base.resultType,
  );
  const body = effectful
    ? ctx.mod.call(
        ensureDispatcher(ctx),
        [callExpr],
        ctx.effectsRuntime.outcomeType,
      )
    : wrapValueInOutcome({
        valueExpr: callExpr,
        valueType: base.resultType,
        typeId: desc.returnType,
        ctx,
        fnCtx: helperFnCtx,
      });

  ctx.mod.addFunction(
    exportName,
    params,
    ctx.effectsRuntime.outcomeType,
    helperFnCtx.locals,
    body,
  );
  if (ctx.programHelpers.registerExportName(exportName)) {
    ctx.mod.addFunctionExport(exportName, exportName);
  }
  starters.set(closureTypeId, exportName);
  return exportName;
};

const ensureRetainedCallbackHelper = ({
  closureTypeId,
  ctx,
}: {
  closureTypeId: TypeId;
  ctx: CodegenContext;
}): string => {
  const helpers = ctx.programHelpers.getHelperState(
    CALLBACK_HELPERS_KEY,
    () => new Map<number, string>(),
  );
  const cached = helpers.get(closureTypeId);
  if (cached) {
    return cached;
  }

  const desc = ctx.program.types.getTypeDesc(closureTypeId);
  if (desc.kind !== "function") {
    throw new Error("callback retention requires a function value");
  }
  ensureLinearMemoryExport(ctx);
  const msgpack = ensureMsgPackFunctions(ctx);
  const parameterCodecs = desc.parameters.map((parameter, index) => {
    const serializer = findSerializerForType(parameter.type, ctx);
    if (serializer && serializer.formatId !== "msgpack") {
      throw new Error(
        `callback parameter serializer format ${serializer.formatId} is not supported`,
      );
    }
    return {
      typeId: parameter.type,
      serializer,
      schema: serializer
        ? undefined
        : deriveBoundarySchema({
            typeId: parameter.type,
            ctx,
            label: `callback parameter ${index + 1}`,
          }),
    };
  });
  const returnWasmType = wasmTypeFor(desc.returnType, ctx);
  const returnsVoid = returnWasmType === binaryen.none;
  const returnSerializer = returnsVoid
    ? undefined
    : findSerializerForType(desc.returnType, ctx);
  if (returnSerializer && returnSerializer.formatId !== "msgpack") {
    throw new Error(
      `callback return serializer format ${returnSerializer.formatId} is not supported`,
    );
  }
  const returnUsesBoundary =
    isBoundaryMsgPackValue(desc.returnType, ctx) ||
    Boolean(boundaryMsgPackPayloadField(desc.returnType, ctx));
  const returnSchema =
    returnSerializer || returnsVoid || returnUsesBoundary
      ? undefined
      : deriveBoundarySchema({
          typeId: desc.returnType,
          ctx,
          label: "callback return",
        });
  const effectful =
    typeof desc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(desc.effectRow);

  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const base = getClosureTypeInfo(closureTypeId, ctx);
  const exportName = `__voyd_callback_${sanitizeTaskKey(base.key)}`;
  const locals: binaryen.Type[] = [];
  const helperFnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: 5,
    returnTypeId: desc.returnType,
    effectful: false,
  };
  const params = binaryen.createType([
    base.interfaceType,
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
  ]);
  const closureRef = ctx.mod.local.get(0, base.interfaceType);
  const decodedPayloadValue = (): binaryen.ExpressionRef =>
    ctx.mod.call(
      msgpack.decodeValue.wasmName,
      [ctx.mod.local.get(1, binaryen.i32), ctx.mod.local.get(2, binaryen.i32)],
      msgPackType,
    );
  const payloadElementValue = (index: number): binaryen.ExpressionRef => {
    if (parameterCodecs.length === 1) {
      return decodedPayloadValue();
    }
    const argsArray = ctx.mod.call(
      msgpack.unpackArray.wasmName,
      [decodedPayloadValue()],
      msgpack.arrayWithCapacity.resultType,
    );
    const storage = ctx.mod.call(
      msgpack.arrayRawStorage.wasmName,
      [argsArray],
      msgpack.arrayRawStorage.resultType,
    );
    return arrayGet(
      ctx.mod,
      storage,
      ctx.mod.i32.const(index),
      msgPackType,
      false,
    );
  };
  const payloadValues = parameterCodecs.map((codec, index) => {
    const value = payloadElementValue(index);
    return codec.serializer
      ? coerceValueToType({
          value,
          actualType: msgpack.msgPackTypeId,
          targetType: codec.typeId,
          ctx,
          fnCtx: helperFnCtx,
        })
      : unpackBoundaryValueFromMsgPack({
          value,
          schema: codec.schema!,
          ctx,
          fnCtx: helperFnCtx,
        });
  });
  const fnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: closureRef,
  });
  const targetFn =
    base.fnRefType === binaryen.funcref
      ? fnField
      : refCast(ctx.mod, fnField, base.fnRefType);
  const loweredPayloads = payloadValues.map((payloadValue, index) =>
    lowerSerializedAbiArg({
      wasmName: exportName,
      abiKind: "direct",
      abiTypes: base.paramAbiTypes[index] ?? [
        binaryen.getExpressionType(payloadValue),
      ],
      typeId: parameterCodecs[index]!.typeId,
      value: payloadValue,
      ctx,
      fnCtx: helperFnCtx,
    }),
  );
  const callExpr = callRef(
    ctx.mod,
    targetFn,
    [
      closureRef,
      ...base.paramTypes
        .slice(0, base.userParamOffset)
        .map(() => ctx.effectsBackend.abi.hiddenHandlerValue(ctx)),
      ...loweredPayloads.flatMap((payload) => payload.args),
    ] as number[],
    base.resultType,
  );
  const setup = loweredPayloads.flatMap((payload) => payload.setup);
  if (effectful) {
    const rawExportName = `${exportName}_effectful_raw`;
    const retainedTargets = ctx.programHelpers.getHelperState(
      EFFECTFUL_RETAINED_CALLBACK_TARGETS_KEY,
      () =>
        new Map<
          string,
          { meta: { effectRow?: number }; exportName: string; emitEntry: false }
        >(),
    );
    retainedTargets.set(exportName, {
      meta: { effectRow: desc.effectRow },
      exportName,
      emitEntry: false,
    });
    const dispatched = ctx.mod.call(
      ensureDispatcher(ctx),
      [callExpr],
      ctx.effectsRuntime.outcomeType,
    );
    ctx.mod.addFunction(
      rawExportName,
      params,
      ctx.effectsRuntime.outcomeType,
      locals,
      setup.length === 0
        ? dispatched
        : ctx.mod.block(
            null,
            [...setup, dispatched],
            ctx.effectsRuntime.outcomeType,
          ),
    );
    if (ctx.programHelpers.registerExportName(rawExportName)) {
      ctx.mod.addFunctionExport(rawExportName, rawExportName);
    }
  }

  const resultValue = effectful
    ? unboxOutcomeValue({
        payload: ctx.effectsRuntime.outcomePayload(
          ctx.mod.call(
            ensureDispatcher(ctx),
            [callExpr],
            ctx.effectsRuntime.outcomeType,
          ),
        ),
        valueType: returnWasmType,
        typeId: desc.returnType,
        ctx,
      })
    : stabilizeSerializedAbiResult({
        value: callExpr,
        resultType: base.resultType,
        resultAbiTypes: base.resultAbiTypes,
        resultTypeId: desc.returnType,
        ctx,
        fnCtx: helperFnCtx,
      });
  const encodedLength = returnsVoid
    ? ctx.mod.block(null, [resultValue, ctx.mod.i32.const(-2)], binaryen.i32)
    : (() => {
        const payloadField = boundaryMsgPackPayloadField(desc.returnType, ctx);
        const encodedResultValue = returnSerializer
          ? coerceValueToType({
              value: resultValue,
              actualType: desc.returnType,
              targetType: msgpack.msgPackTypeId,
              ctx,
              fnCtx: helperFnCtx,
            })
          : isBoundaryMsgPackValue(desc.returnType, ctx)
            ? resultValue
            : payloadField
              ? (() => {
                  const info = getStructuralTypeInfo(desc.returnType, ctx);
                  if (!info) {
                    throw new Error(
                      `boundary payload callback return ${desc.returnType} is missing structural info`,
                    );
                  }
                  return loadStructuralField({
                    structInfo: info,
                    field: payloadField,
                    pointer: () => resultValue,
                    ctx,
                  });
                })()
              : packBoundaryValueAsMsgPack({
                  value: resultValue,
                  schema: returnSchema!,
                  ctx,
                  fnCtx: helperFnCtx,
                });
        return ctx.mod.call(
          msgpack.encodeValue.wasmName,
          [
            encodedResultValue,
            ctx.mod.local.get(3, binaryen.i32),
            ctx.mod.local.get(4, binaryen.i32),
          ],
          binaryen.i32,
        );
      })();

  ctx.mod.addFunction(
    exportName,
    params,
    binaryen.i32,
    locals,
    setup.length === 0
      ? encodedLength
      : ctx.mod.block(null, [...setup, encodedLength], binaryen.i32),
  );
  if (ctx.programHelpers.registerExportName(exportName)) {
    ctx.mod.addFunctionExport(exportName, exportName);
  }
  if (returnsVoid) {
    const markerName = `${exportName}_returns_void`;
    ctx.mod.addFunction(
      markerName,
      binaryen.none,
      binaryen.i32,
      [],
      ctx.mod.i32.const(1),
    );
    if (ctx.programHelpers.registerExportName(markerName)) {
      ctx.mod.addFunctionExport(markerName, markerName);
    }
  }
  helpers.set(closureTypeId, exportName);
  return exportName;
};

const fixedArrayLengthExpr = ({
  array,
  ctx,
}: {
  array: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => arrayLen(ctx.mod, array);

export const compileIntrinsicCall = ({
  name,
  call,
  args,
  ctx,
  fnCtx,
  instanceId,
  paramTypeIds,
  externalIdentity,
}: CompileIntrinsicCallParams): binaryen.ExpressionRef => {
  if (externalIdentity) {
    return compileExternalCall({
      identity: externalIdentity,
      call,
      args,
      ctx,
      fnCtx,
      instanceId,
      paramTypeIds,
    });
  }
  switch (name) {
    case "~": {
      assertArgCount(name, args, 1);
      return args[0]!;
    }
    case "__array_new": {
      assertArgCount(name, args, 1);
      const arrayType = getRequiredExprType(call.id, ctx, instanceId);
      const descriptor = getFixedArrayDescriptor(arrayType, ctx);
      const wasmTypes = getFixedArrayWasmTypes(arrayType, ctx);
      const init = defaultFixedArrayElementValue({
        typeId: descriptor.element,
        ctx,
      });
      return arrayNew(ctx.mod, wasmTypes.heapType, args[0]!, init);
    }
    case "__array_new_fixed": {
      const arrayType = getRequiredExprType(call.id, ctx, instanceId);
      const wasmTypes = getFixedArrayWasmTypes(arrayType, ctx);
      const desc = getFixedArrayDescriptor(arrayType, ctx);
      const values = args.map((value, index) =>
        lowerFixedArrayElementValue({
          value: coerceValueToType({
            value: value!,
            actualType: getRequiredExprType(
              call.args[index]!.expr,
              ctx,
              instanceId,
            ),
            targetType: desc.element,
            ctx,
            fnCtx,
          }),
          typeId: desc.element,
          ctx,
          fnCtx,
        }),
      );
      return arrayNewFixed(ctx.mod, wasmTypes.heapType, values as number[]);
    }
    case "__array_get": {
      if (args.length === 2) {
        const arrayTypeId = getRequiredExprType(
          call.args[0]!.expr,
          ctx,
          instanceId,
        );
        const arrayDesc = getFixedArrayDescriptor(arrayTypeId, ctx);
        return liftFixedArrayElementValue({
          value: arrayGet(
            ctx.mod,
            args[0]!,
            args[1]!,
            fixedArrayStorageElementType({ typeId: arrayDesc.element, ctx }),
            false,
          ),
          typeId: arrayDesc.element,
          ctx,
          fnCtx,
        });
      }
      assertArgCount(name, args, 4);
      const elementType = getBinaryenTypeArg({
        call,
        ctx,
        index: 2,
        instanceId,
        name,
      });
      const signed = getBooleanLiteralArg({ name, call, ctx, index: 3 });
      return arrayGet(ctx.mod, args[0]!, args[1]!, elementType, signed);
    }
    case "__ref_is_null": {
      assertArgCount(name, args, 1);
      const valueType = wasmTypeFor(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx,
      );
      if (
        valueType === binaryen.i32 ||
        valueType === binaryen.i64 ||
        valueType === binaryen.f32 ||
        valueType === binaryen.f64
      ) {
        return ctx.mod.block(
          null,
          [ctx.mod.drop(args[0]!), ctx.mod.i32.const(0)],
          binaryen.i32,
        );
      }
      return ctx.mod.ref.is_null(args[0]!);
    }
    case "__array_set": {
      assertArgCount(name, args, 3);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceId,
      );
      const arrayTypeId = getRequiredExprType(call.id, ctx, instanceId);
      const desc = getFixedArrayDescriptor(arrayTypeId, ctx);
      const value = lowerFixedArrayElementValue({
        value: args[2]!,
        typeId: desc.element,
        ctx,
        fnCtx,
      });
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arraySet(ctx.mod, target, args[1]!, value),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceId),
      );
    }
    case "__array_len": {
      assertArgCount(name, args, 1);
      return fixedArrayLengthExpr({
        array: args[0]!,
        ctx,
      });
    }
    case "__array_copy": {
      if (args.length === 2) {
        return emitArrayCopyFromOptions({
          call,
          args,
          ctx,
          fnCtx,
          instanceId,
        });
      }
      assertArgCount(name, args, 5);
      const arrayType = getExprBinaryenType(
        call.args[0]!.expr,
        ctx,
        instanceId,
      );
      const temp = allocateTempLocal(arrayType, fnCtx);
      const target = ctx.mod.local.get(temp.index, arrayType);
      return ctx.mod.block(
        null,
        [
          ctx.mod.local.set(temp.index, args[0]!),
          arrayCopy(ctx.mod, target, args[1]!, args[2]!, args[3]!, args[4]!),
          ctx.mod.local.get(temp.index, arrayType),
        ],
        getExprBinaryenType(call.id, ctx, instanceId),
      );
    }
    case "__type_to_heap_type": {
      assertArgCount(name, args, 1);
      return getHeapTypeArg({ call, ctx, index: 0, instanceId, name });
    }
    case "__memory_size": {
      assertArgCount(name, args, 0);
      return ctx.mod.memory.size(LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_grow": {
      assertArgCount(name, args, 1);
      return ctx.mod.memory.grow(args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_load_u8": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load8_u(0, 1, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u8": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store8(
        0,
        1,
        args[0]!,
        args[1]!,
        LINEAR_MEMORY_INTERNAL,
      );
    }
    case "__memory_load_u16": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load16_u(0, 2, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u16": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store16(
        0,
        2,
        args[0]!,
        args[1]!,
        LINEAR_MEMORY_INTERNAL,
      );
    }
    case "__memory_load_u32": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.load(0, 4, args[0]!, LINEAR_MEMORY_INTERNAL);
    }
    case "__memory_store_u32": {
      assertArgCount(name, args, 2);
      return ctx.mod.i32.store(
        0,
        4,
        args[0]!,
        args[1]!,
        LINEAR_MEMORY_INTERNAL,
      );
    }
    case "__memory_copy": {
      assertArgCount(name, args, 3);
      return ctx.mod.memory.copy(
        args[0]!,
        args[1]!,
        args[2]!,
        LINEAR_MEMORY_INTERNAL,
        LINEAR_MEMORY_INTERNAL,
      );
    }
    case "__panic_scratch_ptr": {
      assertArgCount(name, args, 0);
      ensurePanicTrapGlobals(ctx);
      return ctx.mod.global.get(PANIC_SCRATCH_PTR_GLOBAL, binaryen.i32);
    }
    case "__panic_scratch_capacity": {
      assertArgCount(name, args, 0);
      ensurePanicTrapGlobals(ctx);
      return ctx.mod.global.get(PANIC_SCRATCH_CAPACITY_GLOBAL, binaryen.i32);
    }
    case "__panic_scratch_set": {
      assertArgCount(name, args, 2);
      ensurePanicTrapGlobals(ctx);
      return ctx.mod.block(null, [
        ctx.mod.global.set(PANIC_SCRATCH_PTR_GLOBAL, args[0]!),
        ctx.mod.global.set(PANIC_SCRATCH_CAPACITY_GLOBAL, args[1]!),
      ]);
    }
    case "__panic_trap": {
      assertArgCount(name, args, 2);
      ensurePanicTrapGlobals(ctx);
      return ctx.mod.block(null, [
        ctx.mod.global.set(PANIC_TRAP_PTR_GLOBAL, args[0]!),
        ctx.mod.global.set(PANIC_TRAP_LEN_GLOBAL, args[1]!),
        ctx.mod.unreachable(),
      ]);
    }
    case "__task_spawn":
    case "__task_detach": {
      assertArgCount(name, args, 1);
      const workTypeId = getRequiredExprType(
        call.args[0]!.expr,
        ctx,
        instanceId,
      );
      const workType = ctx.program.types.getTypeDesc(workTypeId);
      if (workType.kind !== "function") {
        throw new Error(`${name} requires a function-typed work value`);
      }
      const starterExport = ensureTaskStarterHelper({
        closureTypeId: workTypeId,
        ctx,
      });
      const closureInfo = getClosureTypeInfo(workTypeId, ctx);
      const hiddenParamTypes = closureInfo.paramTypes.slice(
        0,
        closureInfo.userParamOffset,
      );
      const importName = `__voyd_${name}_${sanitizeTaskKey(starterExport)}`;
      const importFn = ensureTaskImport({
        name: importName,
        base: `${name === "__task_detach" ? "spawn_detached" : "spawn_attached"}__${starterExport}`,
        params: [closureInfo.interfaceType, ...hiddenParamTypes],
        result: binaryen.i32,
        ctx,
      });
      return ctx.mod.call(
        importFn,
        [
          args[0]!,
          ...hiddenParamTypes.map(() => currentHandlerValue(ctx, fnCtx)),
        ],
        binaryen.i32,
      );
    }
    case "__task_cancel": {
      assertArgCount(name, args, 1);
      const importFn = ensureTaskImport({
        name: "__voyd_task_cancel",
        base: "cancel",
        params: [binaryen.i32],
        result: binaryen.i32,
        ctx,
      });
      return ctx.mod.call(importFn, [args[0]!], binaryen.i32);
    }
    case "__task_take_value": {
      assertArgCount(name, args, 1);
      const importFn = ensureTaskImport({
        name: "__voyd_task_take_value",
        base: "take_value",
        params: [binaryen.i32],
        result: ctx.effectsRuntime.outcomeType,
        ctx,
      });
      const outcome = ctx.mod.call(
        importFn,
        [args[0]!],
        ctx.effectsRuntime.outcomeType,
      );
      const payload = ctx.effectsRuntime.outcomePayload(outcome);
      const returnTypeId = getRequiredExprType(call.id, ctx, instanceId);
      return unboxOutcomeValue({
        payload,
        valueType: wasmTypeFor(returnTypeId, ctx),
        typeId: returnTypeId,
        ctx,
      });
    }
    case "__retain_callback":
    case "__boundary_retain_callback":
    case "__render_retain_callback": {
      assertArgCount(name, args, 1);
      const handlerTypeId = getRequiredExprType(
        call.args[0]!.expr,
        ctx,
        instanceId,
      );
      const handlerType = ctx.program.types.getTypeDesc(handlerTypeId);
      if (handlerType.kind !== "function") {
        throw new Error(`${name} requires a function-typed value`);
      }
      const helperExport = ensureRetainedCallbackHelper({
        closureTypeId: handlerTypeId,
        ctx,
      });
      const closureInfo = getClosureTypeInfo(handlerTypeId, ctx);
      const render = name === "__render_retain_callback";
      const boundary = name === "__boundary_retain_callback";
      const importName = render
        ? `__voyd_render_retain_callback_${sanitizeTaskKey(helperExport)}`
        : boundary
          ? `__voyd_boundary_retain_callback_${sanitizeTaskKey(helperExport)}`
          : `__voyd_retain_callback_${sanitizeTaskKey(helperExport)}`;
      const importFn = render
        ? ensureRenderCallbackImport({
            name: importName,
            base: `retain_render_callback__${helperExport}`,
            params: [closureInfo.interfaceType],
            result: binaryen.i32,
            ctx,
          })
        : boundary
          ? ensureBoundaryCallbackImport({
              name: importName,
              base: `retain_callback__${helperExport}`,
              params: [closureInfo.interfaceType],
              result: binaryen.i32,
              ctx,
            })
          : ensureCallbackImport({
              name: importName,
              base: `retain__${helperExport}`,
              params: [closureInfo.interfaceType],
              result: binaryen.i32,
              ctx,
            });
      return ctx.mod.call(importFn, [args[0]!], binaryen.i32);
    }
    case "__render_claim_callback": {
      assertArgCount(name, args, 1);
      const importFn = ensureCallbackScopeImport({
        name: "__voyd_claim_retained_callback",
        base: "claim",
        params: [binaryen.i32],
        result: binaryen.none,
        ctx,
      });
      return ctx.mod.call(importFn, [args[0]!], binaryen.none);
    }
    case "__stable_callsite_id": {
      assertArgCount(name, args, 0);
      return ctx.mod.i32.const(stableCallsiteIdFor(call.span));
    }
    case "__boundary_value_to_msgpack": {
      assertArgCount(name, args, 1);
      const valueTypeId = getRequiredExprType(
        call.args[0]!.expr,
        ctx,
        instanceId,
      );
      const serializer = findSerializerForType(valueTypeId, ctx);
      if (serializer) {
        if (serializer.formatId !== "msgpack") {
          throw new Error(
            `boundary value serializer format ${serializer.formatId} is not supported`,
          );
        }
        const msgpack = ensureMsgPackFunctions(ctx);
        return coerceValueToType({
          value: args[0]!,
          actualType: valueTypeId,
          targetType: msgpack.msgPackTypeId,
          ctx,
          fnCtx,
        });
      }
      return packBoundaryValueAsMsgPack({
        value: args[0]!,
        schema: deriveBoundarySchema({
          typeId: valueTypeId,
          ctx,
          label: "__boundary_value_to_msgpack value",
          options: { tagStandaloneVariants: true },
        }),
        ctx,
        fnCtx,
      });
    }
    case "__boundary_msgpack_to_value": {
      assertArgCount(name, args, 1);
      const returnTypeId = getRequiredExprType(call.id, ctx, instanceId);
      const serializer = findSerializerForType(returnTypeId, ctx);
      if (serializer) {
        if (serializer.formatId !== "msgpack") {
          throw new Error(
            `boundary value deserializer format ${serializer.formatId} is not supported`,
          );
        }
        const msgpack = ensureMsgPackFunctions(ctx);
        return coerceValueToType({
          value: args[0]!,
          actualType: msgpack.msgPackTypeId,
          targetType: returnTypeId,
          ctx,
          fnCtx,
        });
      }
      return unpackBoundaryValueFromMsgPack({
        value: args[0]!,
        schema: deriveBoundarySchema({
          typeId: returnTypeId,
          ctx,
          label: "__boundary_msgpack_to_value target",
          options: { tagStandaloneVariants: true },
        }),
        ctx,
        fnCtx,
      });
    }
    case "__shift_l":
    case "__shift_ru": {
      assertArgCount(name, args, 2);
      const valueKind = requireIntegerKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx,
      );
      if (valueKind === "i32") {
        return name === "__shift_l"
          ? ctx.mod.i32.shl(args[0]!, args[1]!)
          : ctx.mod.i32.shr_u(args[0]!, args[1]!);
      }
      const shiftType = getRequiredExprType(
        call.args[1]!.expr,
        ctx,
        instanceId,
      );
      const shiftExpr =
        shiftType === ctx.program.primitives.i32
          ? ctx.mod.i64.extend_u(args[1]!)
          : args[1]!;
      return name === "__shift_l"
        ? ctx.mod.i64.shl(args[0]!, shiftExpr)
        : ctx.mod.i64.shr_u(args[0]!, shiftExpr);
    }
    case "__bit_and":
    case "__bit_or":
    case "__bit_xor": {
      assertArgCount(name, args, 2);
      const valueKind = requireIntegerKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx,
      );
      if (valueKind === "i32") {
        switch (name) {
          case "__bit_and":
            return ctx.mod.i32.and(args[0]!, args[1]!);
          case "__bit_or":
            return ctx.mod.i32.or(args[0]!, args[1]!);
          case "__bit_xor":
            return ctx.mod.i32.xor(args[0]!, args[1]!);
        }
      }
      switch (name) {
        case "__bit_and":
          return ctx.mod.i64.and(args[0]!, args[1]!);
        case "__bit_or":
          return ctx.mod.i64.or(args[0]!, args[1]!);
        case "__bit_xor":
          return ctx.mod.i64.xor(args[0]!, args[1]!);
      }
      return ctx.mod.unreachable();
    }
    case "__i32_wrap_i64": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.wrap(args[0]!);
    }
    case "__i64_extend_u": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.extend_u(args[0]!);
    }
    case "__i64_extend_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.extend_s(args[0]!);
    }
    case "__i32_trunc_f32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.trunc_s.f32(args[0]!);
    }
    case "__i32_trunc_f64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.trunc_s.f64(args[0]!);
    }
    case "__i64_trunc_f32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.trunc_s.f32(args[0]!);
    }
    case "__i64_trunc_f64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.trunc_s.f64(args[0]!);
    }
    case "__f32_convert_i32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.convert_s.i32(args[0]!);
    }
    case "__f32_convert_i64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.convert_s.i64(args[0]!);
    }
    case "__f64_convert_i32_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.convert_s.i32(args[0]!);
    }
    case "__f64_convert_i64_s": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.convert_s.i64(args[0]!);
    }
    case "__reinterpret_f32_to_i32": {
      assertArgCount(name, args, 1);
      return ctx.mod.i32.reinterpret(args[0]!);
    }
    case "__reinterpret_i32_to_f32": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.reinterpret(args[0]!);
    }
    case "__reinterpret_f64_to_i64": {
      assertArgCount(name, args, 1);
      return ctx.mod.i64.reinterpret(args[0]!);
    }
    case "__reinterpret_i64_to_f64": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.reinterpret(args[0]!);
    }
    case "__f32_demote_f64": {
      assertArgCount(name, args, 1);
      return ctx.mod.f32.demote(args[0]!);
    }
    case "__f64_promote_f32": {
      assertArgCount(name, args, 1);
      return ctx.mod.f64.promote(args[0]!);
    }
    case "__floor":
    case "__ceil":
    case "__round":
    case "__trunc":
    case "__sqrt": {
      assertArgCount(name, args, 1);
      const kind = requireFloatKind(
        getRequiredExprType(call.args[0]!.expr, ctx, instanceId),
        ctx,
      );
      return emitFloatUnaryIntrinsic({
        op: name,
        kind,
        arg: args[0]!,
        ctx,
      });
    }
    case "+":
    case "*":
    case "/": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId,
      );
      return emitArithmeticIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "-": {
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId,
      );
      if (args.length === 1) {
        return emitUnaryNegationIntrinsic({
          kind: operandKind,
          arg: args[0]!,
          ctx,
        });
      }
      assertArgCount(name, args, 2);
      return emitArithmeticIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "%": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousIntegerKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitModuloIntrinsic({ kind: operandKind, args, ctx });
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousNumericKind(
        call.args.map((a) => a.expr),
        ctx,
        instanceId,
      );
      return emitComparisonIntrinsic({
        op: name,
        kind: operandKind,
        args,
        ctx,
      });
    }
    case "==":
    case "!=": {
      assertArgCount(name, args, 2);
      const operandKind = requireHomogeneousEqualityKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitEqualityIntrinsic({ op: name, kind: operandKind, args, ctx });
    }
    case "and":
    case "or":
    case "xor": {
      assertArgCount(name, args, 2);
      requireBooleanKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitBooleanBinaryIntrinsic({
        op: name,
        args,
        ctx,
      });
    }
    case "not": {
      assertArgCount(name, args, 1);
      requireBooleanKind({
        argExprIds: call.args.map((a) => a.expr),
        ctx,
        instanceId,
      });
      return emitBooleanNotIntrinsic({ arg: args[0]!, ctx });
    }
    default:
      throw new Error(`unsupported intrinsic ${name}`);
  }
};

const emitArithmeticIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: {
  op: "+" | "-" | "*" | "/";
} & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "+":
          return ctx.mod.i32.add(left, right);
        case "-":
          return ctx.mod.i32.sub(left, right);
        case "*":
          return ctx.mod.i32.mul(left, right);
        case "/":
          return ctx.mod.i32.div_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "+":
          return ctx.mod.i64.add(left, right);
        case "-":
          return ctx.mod.i64.sub(left, right);
        case "*":
          return ctx.mod.i64.mul(left, right);
        case "/":
          return ctx.mod.i64.div_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "+":
          return ctx.mod.f32.add(left, right);
        case "-":
          return ctx.mod.f32.sub(left, right);
        case "*":
          return ctx.mod.f32.mul(left, right);
        case "/":
          return ctx.mod.f32.div(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "+":
          return ctx.mod.f64.add(left, right);
        case "-":
          return ctx.mod.f64.sub(left, right);
        case "*":
          return ctx.mod.f64.mul(left, right);
        case "/":
          return ctx.mod.f64.div(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} intrinsic for numeric kind ${kind}`);
};

const emitUnaryNegationIntrinsic = ({
  kind,
  arg,
  ctx,
}: {
  kind: NumericKind;
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  switch (kind) {
    case "i32":
      return ctx.mod.i32.sub(ctx.mod.i32.const(0), arg);
    case "i64":
      return ctx.mod.i64.sub(ctx.mod.i64.const(0, 0), arg);
    case "f32":
      return ctx.mod.f32.neg(arg);
    case "f64":
      return ctx.mod.f64.neg(arg);
  }
};

const emitFloatUnaryIntrinsic = ({
  op,
  kind,
  arg,
  ctx,
}: EmitFloatUnaryIntrinsicParams): binaryen.ExpressionRef => {
  if (kind === "f32") {
    switch (op) {
      case "__floor":
        return ctx.mod.f32.floor(arg);
      case "__ceil":
        return ctx.mod.f32.ceil(arg);
      case "__round":
        return ctx.mod.f32.nearest(arg);
      case "__trunc":
        return ctx.mod.f32.trunc(arg);
      case "__sqrt":
        return ctx.mod.f32.sqrt(arg);
    }
  }

  switch (op) {
    case "__floor":
      return ctx.mod.f64.floor(arg);
    case "__ceil":
      return ctx.mod.f64.ceil(arg);
    case "__round":
      return ctx.mod.f64.nearest(arg);
    case "__trunc":
      return ctx.mod.f64.trunc(arg);
    case "__sqrt":
      return ctx.mod.f64.sqrt(arg);
  }
};

const emitComparisonIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: {
  op: "<" | "<=" | ">" | ">=";
} & EmitNumericIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      switch (op) {
        case "<":
          return ctx.mod.i32.lt_s(left, right);
        case "<=":
          return ctx.mod.i32.le_s(left, right);
        case ">":
          return ctx.mod.i32.gt_s(left, right);
        case ">=":
          return ctx.mod.i32.ge_s(left, right);
      }
      break;
    case "i64":
      switch (op) {
        case "<":
          return ctx.mod.i64.lt_s(left, right);
        case "<=":
          return ctx.mod.i64.le_s(left, right);
        case ">":
          return ctx.mod.i64.gt_s(left, right);
        case ">=":
          return ctx.mod.i64.ge_s(left, right);
      }
      break;
    case "f32":
      switch (op) {
        case "<":
          return ctx.mod.f32.lt(left, right);
        case "<=":
          return ctx.mod.f32.le(left, right);
        case ">":
          return ctx.mod.f32.gt(left, right);
        case ">=":
          return ctx.mod.f32.ge(left, right);
      }
      break;
    case "f64":
      switch (op) {
        case "<":
          return ctx.mod.f64.lt(left, right);
        case "<=":
          return ctx.mod.f64.le(left, right);
        case ">":
          return ctx.mod.f64.gt(left, right);
        case ">=":
          return ctx.mod.f64.ge(left, right);
      }
      break;
  }
  throw new Error(`unsupported ${op} comparison for numeric kind ${kind}`);
};

const emitModuloIntrinsic = ({
  kind,
  args,
  ctx,
}: {
  kind: IntegerKind;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "i32":
      return ctx.mod.i32.rem_s(left, right);
    case "i64":
      return ctx.mod.i64.rem_s(left, right);
  }
};

const emitEqualityIntrinsic = ({
  op,
  kind,
  args,
  ctx,
}: EmitEqualityIntrinsicParams): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (kind) {
    case "bool":
      return op === "=="
        ? ctx.mod.i32.eq(left, right)
        : ctx.mod.i32.ne(left, right);
    case "i32":
      return op === "=="
        ? ctx.mod.i32.eq(left, right)
        : ctx.mod.i32.ne(left, right);
    case "i64":
      return op === "=="
        ? ctx.mod.i64.eq(left, right)
        : ctx.mod.i64.ne(left, right);
    case "f32":
      return op === "=="
        ? ctx.mod.f32.eq(left, right)
        : ctx.mod.f32.ne(left, right);
    case "f64":
      return op === "=="
        ? ctx.mod.f64.eq(left, right)
        : ctx.mod.f64.ne(left, right);
  }
  throw new Error(`unsupported ${op} equality for kind ${kind}`);
};

const emitBooleanBinaryIntrinsic = ({
  op,
  args,
  ctx,
}: {
  op: "and" | "or" | "xor";
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const left = args[0]!;
  const right = args[1]!;
  switch (op) {
    case "and":
      return ctx.mod.if(left, right, ctx.mod.i32.const(0));
    case "or":
      return ctx.mod.if(left, ctx.mod.i32.const(1), right);
    case "xor":
      return ctx.mod.i32.xor(left, right);
  }
};

const emitBooleanNotIntrinsic = ({
  arg,
  ctx,
}: {
  arg: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => ctx.mod.i32.eqz(arg);

const requireHomogeneousNumericKind = (
  argExprIds: readonly HirExprId[],
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): NumericKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getNumericKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx,
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getNumericKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx,
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same numeric type");
    }
  }
  return firstKind;
};

const requireHomogeneousEqualityKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): EqualityKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getEqualityKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx,
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getEqualityKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx,
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same primitive type");
    }
  }
  return firstKind;
};

const requireHomogeneousIntegerKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): IntegerKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = requireIntegerKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx,
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = requireIntegerKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx,
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must share the same integer type");
    }
  }
  return firstKind;
};

const requireBooleanKind = ({
  argExprIds,
  ctx,
  instanceId,
}: {
  argExprIds: readonly HirExprId[];
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): BooleanKind => {
  if (argExprIds.length === 0) {
    throw new Error("intrinsic requires at least one operand");
  }
  const firstKind = getBooleanKind(
    getRequiredExprType(argExprIds[0]!, ctx, instanceId),
    ctx,
  );
  for (let i = 1; i < argExprIds.length; i += 1) {
    const nextKind = getBooleanKind(
      getRequiredExprType(argExprIds[i]!, ctx, instanceId),
      ctx,
    );
    if (nextKind !== firstKind) {
      throw new Error("intrinsic operands must be boolean types");
    }
  }
  return firstKind;
};

const requireIntegerKind = (
  typeId: TypeId,
  ctx: CodegenContext,
): IntegerKind => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") {
    switch (desc.name) {
      case "i32":
        return "i32";
      case "i64":
        return "i64";
    }
  }
  throw new Error("intrinsic arguments must be i32 or i64");
};

const requireFloatKind = (typeId: TypeId, ctx: CodegenContext): FloatKind => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "primitive") {
    switch (desc.name) {
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error("intrinsic arguments must be f32 or f64");
};

const getNumericKind = (typeId: TypeId, ctx: CodegenContext): NumericKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
  if (descriptor.kind === "primitive") {
    switch (descriptor.name) {
      case "i32":
        return "i32";
      case "i64":
        return "i64";
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error("intrinsic arguments must be primitive numeric types");
};

const getEqualityKind = (typeId: TypeId, ctx: CodegenContext): EqualityKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
  if (descriptor.kind === "primitive") {
    switch (descriptor.name) {
      case "bool":
      case "boolean":
        return "bool";
      case "i32":
        return "i32";
      case "i64":
        return "i64";
      case "f32":
        return "f32";
      case "f64":
        return "f64";
    }
  }
  throw new Error(
    "intrinsic arguments must be primitive numeric or boolean types",
  );
};

const getBooleanKind = (typeId: TypeId, ctx: CodegenContext): BooleanKind => {
  const descriptor = ctx.program.types.getTypeDesc(typeId);
  if (
    descriptor.kind === "primitive" &&
    (descriptor.name === "bool" || descriptor.name === "boolean")
  ) {
    return "bool";
  }
  throw new Error("intrinsic arguments must be boolean types");
};

const assertArgCount = (
  name: string,
  args: readonly unknown[],
  expected: number,
): void => {
  if (args.length !== expected) {
    throw new Error(
      `intrinsic ${name} expected ${expected} args, received ${args.length}`,
    );
  }
};

const getBinaryenTypeArg = ({
  call,
  ctx,
  index,
  instanceId,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceId?: ProgramFunctionInstanceId;
  name?: string;
}): binaryen.Type => {
  const arg = call.args[index];
  if (!arg) {
    const source = name ? `intrinsic ${name}` : "intrinsic";
    throw new Error(`${source} argument ${index + 1} missing`);
  }
  return getExprBinaryenType(arg.expr, ctx, instanceId);
};

const getHeapTypeArg = ({
  call,
  ctx,
  index,
  instanceId,
  name,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
  instanceId?: ProgramFunctionInstanceId;
  name?: string;
}): HeapTypeRef => {
  const type = getBinaryenTypeArg({ call, ctx, index, instanceId, name });
  return modBinaryenTypeToHeapType(ctx.mod, type);
};

const getFixedArrayDescriptor = (
  typeId: TypeId,
  ctx: CodegenContext,
): { kind: "fixed-array"; element: TypeId } => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  return desc as { kind: "fixed-array"; element: TypeId };
};

const emitArrayCopyFromOptions = ({
  call,
  args,
  ctx,
  fnCtx,
  instanceId,
}: {
  call: HirCallExpr;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  instanceId?: ProgramFunctionInstanceId;
}): binaryen.ExpressionRef => {
  const opts = call.args[1];
  if (!opts) {
    throw new Error("array.copy intrinsic missing options argument");
  }
  const arrayType = getExprBinaryenType(call.args[0]!.expr, ctx, instanceId);
  const optsType = getRequiredExprType(opts.expr, ctx, instanceId);
  const structInfo = getStructuralTypeInfo(optsType, ctx);
  if (!structInfo) {
    throw new Error("array.copy options must be a structural object");
  }

  const fieldOrder = ["to_index", "from", "from_index", "count"] as const;
  const fields = fieldOrder.map((field) => {
    const resolved = structInfo.fieldMap.get(field);
    if (!resolved) {
      throw new Error(`array.copy options missing field ${field}`);
    }
    return resolved;
  });

  const destTemp = allocateTempLocal(arrayType, fnCtx);
  const temp = allocateTempLocal(structInfo.interfaceType, fnCtx);
  const target = ctx.mod.local.get(destTemp.index, arrayType);
  const loadField = (field: (typeof fields)[number]): binaryen.ExpressionRef =>
    loadStructuralField({
      structInfo,
      field,
      pointer: () => ctx.mod.local.get(temp.index, structInfo.interfaceType),
      ctx,
    });

  const copyExpr = arrayCopy(
    ctx.mod,
    target,
    loadField(fields[0]!),
    loadField(fields[1]!),
    loadField(fields[2]!),
    loadField(fields[3]!),
  );

  return ctx.mod.block(
    null,
    [
      ctx.mod.local.set(destTemp.index, args[0]!),
      ctx.mod.local.set(temp.index, args[1]!),
      copyExpr,
      ctx.mod.local.get(destTemp.index, arrayType),
    ],
    getExprBinaryenType(call.id, ctx, instanceId),
  );
};

const getBooleanLiteralArg = ({
  name,
  call,
  ctx,
  index,
}: {
  name: string;
  call: HirCallExpr;
  ctx: CodegenContext;
  index: number;
}): boolean => {
  const exprId = call.args[index]?.expr;
  if (typeof exprId !== "number") {
    throw new Error(`intrinsic ${name} missing argument ${index + 1}`);
  }
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "literal" || expr.literalKind !== "boolean") {
    throw new Error(
      `intrinsic ${name} argument ${index + 1} must be a boolean literal`,
    );
  }
  return expr.value === "true";
};
