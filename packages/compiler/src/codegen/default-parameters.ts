import binaryen from "binaryen";
import {
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
  LocalBindingLocal,
} from "./context.js";
import { compileExpression } from "./expressions/index.js";
import {
  allocateTempLocal,
  loadBindingValue,
  storeLocalValue,
} from "./locals.js";
import { coerceValueToType, loadStructuralField } from "./structural.js";
import { RTT_METADATA_SLOTS } from "./rtt/index.js";
import {
  getInlineUnionLayout,
  getRequiredExprType,
  getStructuralTypeInfo,
  shouldInlineUnionLayout,
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

    const rawTypeId = meta.paramTypeIds[index];
    if (typeof rawTypeId !== "number") {
      throw new Error(
        `codegen missing default parameter metadata for symbol ${param.symbol}`,
      );
    }
    const optionalInfo = ctx.program.optionals.getOptionalInfo(
      ctx.moduleId,
      rawTypeId,
    );
    if (!optionalInfo) {
      throw new Error("default parameter must use an Optional wrapper type");
    }
    const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
    if (!someInfo || someInfo.fields.length !== 1) {
      throw new Error(
        "default parameter Optional Some member must contain one value field",
      );
    }
    const someField = someInfo.fields[0]!;
    const rawTemp = ctx.effectLowering.defaultParamTemps.get(param.symbol);
    const rawBinding =
      typeof rawTemp?.tempId === "number"
        ? fnCtx.tempLocals.get(rawTemp.tempId)
        : fnCtx.bindings.get(param.symbol);
    if (!rawBinding) {
      throw new Error(
        `codegen missing bound parameter for optional default symbol ${param.symbol}`,
      );
    }

    const resolved = allocateTempLocal(
      wasmTypeFor(optionalInfo.innerType, ctx),
      fnCtx,
      optionalInfo.innerType,
      ctx,
    );
    fnCtx.bindings.set(param.symbol, {
      ...resolved,
      kind: "local",
      typeId: optionalInfo.innerType,
    });

    const compileDefaultValue = (): binaryen.ExpressionRef => {
      const compiled = (continuation?.compileExpr ?? compileExpression)({
        exprId: param.defaultValue!,
        ctx,
        fnCtx,
        tailPosition: false,
        expectedResultTypeId: optionalInfo.innerType,
      }).expr;
      const actualTypeId = getRequiredExprType(
        param.defaultValue!,
        ctx,
        typeInstanceId,
      );
      return coerceValueToType({
        value: compiled,
        actualType: actualTypeId,
        targetType: optionalInfo.innerType,
        ctx,
        fnCtx,
      });
    };

    const compileNormalStore = (): binaryen.ExpressionRef => {
      const rawParamExpr = () => loadBindingValue(rawBinding, ctx, fnCtx);
      const rawAbiTypes = binaryen.expandType(rawBinding.type);
      const [isSome, extractedSomeValue] = shouldInlineUnionLayout(
        rawTypeId,
        ctx,
      )
        ? (() => {
            const layout = getInlineUnionLayout(rawTypeId, ctx);
            const someLayout = layout.members.find(
              (member) => member.typeId === optionalInfo.someType,
            );
            if (!someLayout) {
              throw new Error(
                "default parameter inline optional layout is missing Some member",
              );
            }
            const tagValue =
              rawAbiTypes.length === 1
                ? rawParamExpr()
                : ctx.mod.tuple.extract(rawParamExpr(), 0);
            const payloadValues = someLayout.abiTypes.map((_, fieldIndex) =>
              rawAbiTypes.length === 1
                ? rawParamExpr()
                : ctx.mod.tuple.extract(
                    rawParamExpr(),
                    someLayout.abiStart + fieldIndex,
                  ),
            );
            const payload =
              payloadValues.length === 0
                ? ctx.mod.nop()
                : payloadValues.length === 1
                  ? payloadValues[0]!
                  : ctx.mod.tuple.make(payloadValues);
            return [
              ctx.mod.i32.eq(tagValue, ctx.mod.i32.const(someLayout.tag)),
              coerceValueToType({
                value: payload,
                actualType: optionalInfo.innerType,
                targetType: optionalInfo.innerType,
                ctx,
                fnCtx,
              }),
            ] as const;
          })()
        : (() => {
            const ancestorsExpr = () =>
              structGetFieldValue({
                mod: ctx.mod,
                fieldType: ctx.rtt.extensionHelpers.i32Array,
                fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
                exprRef: rawParamExpr(),
              });
            return [
              ctx.mod.call(
                "__extends",
                [ctx.mod.i32.const(someInfo.runtimeTypeId), ancestorsExpr()],
                binaryen.i32,
              ),
              coerceValueToType({
                value: loadStructuralField({
                  structInfo: someInfo,
                  field: someField,
                  pointer: () =>
                    refCast(ctx.mod, rawParamExpr(), someInfo.runtimeType),
                  ctx,
                }),
                actualType: someField.typeId,
                targetType: optionalInfo.innerType,
                ctx,
                fnCtx,
              }),
            ] as const;
          })();
      return storeLocalValue({
        binding: resolved,
        value: ctx.mod.if(isSome, extractedSomeValue, compileDefaultValue()),
        ctx,
        fnCtx,
      });
    };

    if (!continuation) {
      ops.push(compileNormalStore());
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
    const directStore = storeLocalValue({
      binding: resolved,
      value: compileDefaultValue(),
      ctx,
      fnCtx,
    });
    ops.push(
      ctx.mod.if(
        resumeCurrent,
        directStore,
        ctx.mod.if(started(), compileNormalStore(), ctx.mod.nop()),
      ),
    );
  });

  return ops;
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
    const binding = allocateTempLocal(
      wasmTypeFor(targetTypeId, ctx),
      fnCtx,
      targetTypeId,
      ctx,
    );
    fnCtx.bindings.set(parameter.symbol, {
      ...binding,
      kind: "local",
      typeId: targetTypeId,
    });
    ops.push(storeLocalValue({ binding, value, ctx, fnCtx }));
  });

  return ops;
};
