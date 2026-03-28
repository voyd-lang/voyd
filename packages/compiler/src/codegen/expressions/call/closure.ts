import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  TypeId,
} from "../../context.js";
import type { EffectRowId } from "../../../semantics/ids.js";
import {
  callRef,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "../../locals.js";
import {
  abiTypeFor,
  getClosureTypeInfo,
  getExprBinaryenType,
  getRequiredExprType,
  getSignatureSpillBoxType,
  wasmTypeFor,
} from "../../types.js";
import { buildInstanceSubstitution } from "../../type-substitution.js";
import { captureMultivalueLanes } from "../../multivalue.js";
import { coerceValueToType } from "../../structural.js";
import { coerceExprToWasmType } from "../../wasm-type-coercions.js";
import {
  boxSignatureSpillValue,
  unboxSignatureSpillValue,
} from "../../signature-spill.js";
import {
  compileCallArgumentsForParams,
  compileCallArgumentsForParamsWithDetails,
} from "./arguments.js";
import {
  compileCallCalleeExpressionWithTemp,
  currentHandlerValue,
  debugEffects,
} from "./shared.js";
import type { CallParam, CompiledCallArgumentsForParams } from "./types.js";

export const compileClosureCall = ({
  expr,
  calleeTypeId,
  calleeDesc,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  calleeDesc: {
    kind: "function";
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
    returnType: TypeId;
    effectRow: EffectRowId;
  };
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
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
    typeId?: TypeId,
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
        `closure ABI flatten mismatch: expected ${abiTypes.length} lanes, got ${valueAbiTypes.length}`,
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

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  const resolvedCalleeTypeId = substitution
    ? ctx.program.types.substitute(calleeTypeId, substitution)
    : calleeTypeId;

  const resolvedDesc = substitution
    ? ctx.program.types.getTypeDesc(resolvedCalleeTypeId)
    : calleeDesc;
  if (resolvedDesc.kind !== "function") {
    throw new Error("expected function type for closure call");
  }

  const base = getClosureTypeInfo(resolvedCalleeTypeId, ctx);
  const effectful =
    typeof resolvedDesc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(resolvedDesc.effectRow);
  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const callResultWasmType = wasmTypeFor(expectedTypeId, ctx);

  if (effectful && debugEffects()) {
    console.log("[effects] closure call", {
      returnType: resolvedDesc.returnType,
      row: ctx.program.effects.getRow(resolvedDesc.effectRow),
    });
  }

  const closureValue = compileCallCalleeExpressionWithTemp({
    call: expr,
    ctx,
    fnCtx,
    compileExpr,
  });

  const closureTemp = allocateTempLocal(base.interfaceType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(closureTemp.index, closureValue.expr),
  ];

  const fnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: ctx.mod.local.get(closureTemp.index, base.interfaceType),
  });
  const targetFn =
    base.fnRefType === binaryen.funcref
      ? fnField
      : refCast(ctx.mod, fnField, base.fnRefType);

  const args = compileClosureArguments({
    call: expr,
    desc: resolvedDesc,
    ctx,
    fnCtx,
    compileExpr,
  });
  const argSetups: binaryen.ExpressionRef[] = [];
  const userArgs = args.flatMap((arg, index) => {
    const flattened = flattenAbiArgument(
      arg,
      base.paramAbiTypes[index] ?? [binaryen.getExpressionType(arg)],
      resolvedDesc.parameters[index]?.type,
    );
    argSetups.push(...flattened.setup);
    return flattened.args;
  });

  const callArgs = effectful
    ? [
        ctx.mod.local.get(closureTemp.index, base.interfaceType),
        currentHandlerValue(ctx, fnCtx),
        ...userArgs,
      ]
    : [ctx.mod.local.get(closureTemp.index, base.interfaceType), ...userArgs];
  const rawCall = callRef(ctx.mod, targetFn, callArgs as number[], base.resultType);
  const directCallResult = effectful
    ? rawCall
    : (() => {
        const stabilizedCall = stabilizeMultivalueResult(rawCall, base.resultAbiTypes);
        return getSignatureSpillBoxType({
          typeId: resolvedDesc.returnType,
          ctx,
        }) === base.resultType
          ? unboxSignatureSpillValue({
              value: stabilizedCall,
              typeId: resolvedDesc.returnType,
              ctx,
            })
          : stabilizedCall;
      })();
  const callExpr =
    argSetups.length === 0
      ? directCallResult
      : ctx.mod.block(
          null,
          [...argSetups, directCallResult],
          binaryen.getExpressionType(directCallResult),
        );

  const lowered = effectful
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
    : {
        expr:
          returnTypeId === expectedTypeId
            ? callExpr
            : coerceExprToWasmType({
                expr: coerceValueToType({
                  value: callExpr,
                  actualType: returnTypeId,
                  targetType: expectedTypeId,
                  ctx,
                  fnCtx,
                }),
                targetType: callResultWasmType,
                ctx,
              }),
        usedReturnCall: false,
      };

  ops.push(lowered.expr);
  return {
    expr:
      ops.length === 1
        ? ops[0]!
        : ctx.mod.block(
            null,
            ops,
            getExprBinaryenType(expr.id, ctx, typeInstanceId)
          ),
    usedReturnCall: lowered.usedReturnCall,
  };
};

export const compileCurriedClosureCall = ({
  expr,
  calleeTypeId,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
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
    typeId?: TypeId,
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
        `closure ABI flatten mismatch: expected ${abiTypes.length} lanes, got ${valueAbiTypes.length}`,
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

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });

  let currentValue = compileCallCalleeExpressionWithTemp({
    call: expr,
    ctx,
    fnCtx,
    compileExpr,
  });
  let currentTypeId = calleeTypeId;
  let argIndex = 0;

  while (argIndex < expr.args.length) {
    const resolvedCurrentTypeId = substitution
      ? ctx.program.types.substitute(currentTypeId, substitution)
      : currentTypeId;
    const currentDesc = ctx.program.types.getTypeDesc(resolvedCurrentTypeId);
    if (currentDesc.kind !== "function") {
      throw new Error("attempted to call a non-function value");
    }

    const params: CallParam[] = currentDesc.parameters.map((param) => ({
      typeId: param.type,
      label: param.label,
      optional: param.optional,
    }));
    const remainingCall: HirCallExpr = {
      ...expr,
      args: expr.args.slice(argIndex),
    };

    const compileArgsForSlice = (): CompiledCallArgumentsForParams => {
      try {
        return compileCallArgumentsForParamsWithDetails({
          call: remainingCall,
          params,
          ctx,
          fnCtx,
          compileExpr,
          options: {
            typeInstanceId,
            argIndexOffset: argIndex,
            allowTrailingArguments: true,
            allCallArgExprIds: expr.args.map((arg) => arg.expr),
          },
        });
      } catch (error) {
        const signature = currentDesc.parameters
          .map(
            (param) =>
              `${param.label ?? "_"}${param.optional ? "?" : ""}:${param.type}`
          )
          .join(", ");
        throw new Error(
          `curried closure call argument mismatch (call ${expr.id} in ${ctx.moduleId}; stage offset=${argIndex}; signature=(${signature}) -> ${currentDesc.returnType}): ${(error as Error).message}`
        );
      }
    };

    const compiledSlice = compileArgsForSlice();
    if (compiledSlice.consumedArgCount === 0) {
      throw new Error(
        `curried closure call made no argument progress (call ${expr.id} in ${ctx.moduleId}; stage offset=${argIndex})`
      );
    }

    const isFinalSlice = argIndex + compiledSlice.consumedArgCount >= expr.args.length;

    const base = getClosureTypeInfo(resolvedCurrentTypeId, ctx);
    const closureTemp = allocateTempLocal(base.interfaceType, fnCtx);
    const ops: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(closureTemp.index, currentValue.expr),
    ];

    const fnField = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 0,
      fieldType: binaryen.funcref,
      exprRef: ctx.mod.local.get(closureTemp.index, base.interfaceType),
    });
    const targetFn =
      base.fnRefType === binaryen.funcref
        ? fnField
        : refCast(ctx.mod, fnField, base.fnRefType);

    const effectful =
      typeof currentDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(currentDesc.effectRow);
    if (effectful && debugEffects()) {
      console.log("[effects] curried closure call", {
        returnType: currentDesc.returnType,
        row: ctx.program.effects.getRow(currentDesc.effectRow),
      });
    }

    const returnTypeId = currentDesc.returnType;
    const expectedTypeId =
      isFinalSlice && typeof expectedResultTypeId === "number"
        ? expectedResultTypeId
        : returnTypeId;
    const returnWasmType = wasmTypeFor(expectedTypeId, ctx);
    const argSetups: binaryen.ExpressionRef[] = [];
    const args = compiledSlice.args.flatMap((arg, index) => {
      const flattened = flattenAbiArgument(
        arg,
        base.paramAbiTypes[index] ?? [binaryen.getExpressionType(arg)],
        currentDesc.parameters[index]?.type,
      );
      argSetups.push(...flattened.setup);
      return flattened.args;
    });

    const callArgs = effectful
      ? [
          ctx.mod.local.get(closureTemp.index, base.interfaceType),
          currentHandlerValue(ctx, fnCtx),
          ...args,
        ]
      : [ctx.mod.local.get(closureTemp.index, base.interfaceType), ...args];
    const rawCall = callRef(ctx.mod, targetFn, callArgs as number[], base.resultType);
    const directCallResult = effectful
      ? rawCall
      : (() => {
          const stabilizedCall = stabilizeMultivalueResult(rawCall, base.resultAbiTypes);
          return getSignatureSpillBoxType({ typeId: returnTypeId, ctx }) === base.resultType
            ? unboxSignatureSpillValue({
                value: stabilizedCall,
                typeId: returnTypeId,
                ctx,
              })
            : stabilizedCall;
        })();
    const callExpr =
      argSetups.length === 0
        ? directCallResult
        : ctx.mod.block(
            null,
            [...argSetups, directCallResult],
            binaryen.getExpressionType(directCallResult),
          );

    const lowered = effectful
      ? ctx.effectsBackend.lowerEffectfulCallResult({
          callExpr,
          callId: expr.id,
          returnTypeId,
          expectedResultTypeId: isFinalSlice ? expectedResultTypeId : undefined,
          tailPosition: tailPosition && isFinalSlice,
          typeInstanceId,
          ctx,
          fnCtx,
        })
      : {
          expr:
            returnTypeId === expectedTypeId
              ? callExpr
              : coerceExprToWasmType({
                  expr: coerceValueToType({
                    value: callExpr,
                    actualType: returnTypeId,
                    targetType: expectedTypeId,
                    ctx,
                    fnCtx,
                  }),
                  targetType: returnWasmType,
                  ctx,
                }),
          usedReturnCall: false,
        };

    ops.push(lowered.expr);
    currentValue = {
      expr:
        ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, returnWasmType),
      usedReturnCall: lowered.usedReturnCall,
    };
    currentTypeId = returnTypeId;
    argIndex += compiledSlice.consumedArgCount;
  }

  return currentValue;
};

const compileClosureArguments = ({
  call,
  desc,
  ctx,
  fnCtx,
  compileExpr,
}: {
  call: HirCallExpr;
  desc: {
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
  };
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const params: CallParam[] = desc.parameters.map((param) => ({
    typeId: param.type,
    label: param.label,
    optional: param.optional,
  }));

  return compileCallArgumentsForParams({
    call,
    params,
    ctx,
    fnCtx,
    compileExpr,
    options: { typeInstanceId },
  });
};
