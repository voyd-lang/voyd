import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  refFunc,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirLambdaExpr,
} from "../context.js";
import {
  getClosureTypeInfo,
  getRequiredExprType,
  getSymbolTypeId,
  wasmTypeFor,
} from "../types.js";
import { getRequiredBinding, loadBindingValue } from "../locals.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { effectsFacade } from "../effects/facade.js";
import { emitPureSurfaceWrapper } from "../effects/abi-wrapper.js";

type LambdaCaptureInfo = {
  symbol: number;
  typeId: number;
  wasmType: binaryen.Type;
  mutable: boolean;
  fieldIndex: number;
};

type LambdaEnvInfo = NonNullable<
  ReturnType<CodegenContext["lambdaEnvs"]["get"]>
>;

const formatLambdaInstanceKey = (
  exprId: number,
  outerInstance?: string
): string =>
  outerInstance ? `${outerInstance}::lambda${exprId}` : `lambda${exprId}`;

const makeLambdaKey = (exprId: number, ctx: CodegenContext, outer?: string) =>
  `${ctx.moduleId}::${formatLambdaInstanceKey(exprId, outer)}`;

const makeLambdaFunctionName = ({
  expr,
  ctx,
  instanceKey,
}: {
  expr: HirLambdaExpr;
  ctx: CodegenContext;
  instanceKey: string;
}): string => {
  const safeInstance = instanceKey.replace(/[^a-zA-Z0-9_]/g, "_");
  return `${ctx.moduleLabel}__lambda_${expr.id}_${safeInstance}`;
};

const defineLambdaEnvType = ({
  base,
  captures,
  expr,
  ctx,
  instanceKey,
}: {
  base: ReturnType<typeof getClosureTypeInfo>;
  captures: readonly LambdaCaptureInfo[];
  expr: HirLambdaExpr;
  ctx: CodegenContext;
  instanceKey: string;
}): binaryen.Type =>
  defineStructType(ctx.mod, {
    name: `${ctx.moduleLabel}__lambda_env_${expr.id}_${instanceKey.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    fields: [
      { name: "__fn", type: binaryen.funcref, mutable: false },
      ...captures.map((capture, index) => ({
        name: `c${index}`,
        type: capture.wasmType,
        mutable: capture.mutable,
      })),
    ],
    supertype: binaryenTypeToHeapType(base.interfaceType),
    final: true,
  });

const emitLambdaFunction = ({
  expr,
  ctx,
  env,
  fnName,
  instanceKey,
  typeInstanceKey,
  compileExpr,
}: {
  expr: HirLambdaExpr;
  ctx: CodegenContext;
  env: LambdaEnvInfo;
  fnName: string;
  instanceKey: string;
  typeInstanceKey?: string;
  compileExpr: ExpressionCompiler;
}): void => {
  const desc = ctx.program.types.getTypeDesc(env.typeId);
  if (desc.kind !== "function") {
    throw new Error("lambda missing function type");
  }
  if (desc.parameters.length !== expr.parameters.length) {
    throw new Error("lambda parameter count mismatch");
  }

  const params = [env.base.interfaceType, ...env.base.paramTypes];
  const typeEffectful =
    typeof desc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(desc.effectRow);
  const lambdaInfo = effectsFacade(ctx).lambdaAbi(expr.id);
  const abiEffectful = lambdaInfo?.abiEffectful ?? typeEffectful;
  const needsWrapper = abiEffectful && !typeEffectful;

  if (needsWrapper) {
    const handlerParamType = ctx.effectsRuntime.handlerFrameType;
    const implName = `${fnName}__effectful_impl`;
    const implParams = [env.base.interfaceType, handlerParamType, ...env.base.paramTypes];

    const implCtx: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals: [],
      nextLocalIndex: implParams.length,
      returnTypeId: desc.returnType,
      instanceKey,
      typeInstanceKey,
      effectful: true,
      currentHandler: { index: 1, type: handlerParamType },
    };

    expr.parameters.forEach((param, index) => {
      const binding = {
        kind: "local" as const,
        index: index + 2,
        type: env.base.paramTypes[index]!,
        typeId: desc.parameters[index]!.type,
      };
      implCtx.bindings.set(param.symbol, binding);
    });

    env.captures.forEach((capture) => {
      implCtx.bindings.set(capture.symbol, {
        kind: "capture",
        envIndex: 0,
        envType: env.envType,
        envSuperType: env.base.interfaceType,
        fieldIndex: capture.fieldIndex,
        type: capture.wasmType,
        typeId: capture.typeId,
        mutable: capture.mutable,
      });
    });

    const implBody = compileExpr({
      exprId: expr.body,
      ctx,
      fnCtx: implCtx,
      tailPosition: true,
      expectedResultTypeId: desc.returnType,
    });
    const returnWasmType = wasmTypeFor(desc.returnType, ctx);
    const implFunctionBody =
      binaryen.getExpressionType(implBody.expr) === returnWasmType
        ? wrapValueInOutcome({
            valueExpr: implBody.expr,
            valueType: returnWasmType,
            ctx,
          })
        : implBody.expr;

    ctx.mod.addFunction(
      implName,
      binaryen.createType(implParams as number[]),
      ctx.effectsRuntime.outcomeType,
      implCtx.locals,
      implFunctionBody
    );

    emitPureSurfaceWrapper({
      ctx,
      wrapperName: fnName,
      wrapperParamTypes: params,
      wrapperResultType: env.base.resultType,
      implName,
      buildImplCallArgs: () => [
        ctx.mod.local.get(0, env.base.interfaceType),
        ctx.mod.ref.null(handlerParamType),
        ...expr.parameters.map((_, index) =>
          ctx.mod.local.get(index + 1, env.base.paramTypes[index] as number)
        ),
      ],
    });
    return;
  }

  const effectful = abiEffectful;
  const handlerOffset = effectful ? 1 : 0;
  const lambdaCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: params.length,
    returnTypeId: desc.returnType,
    instanceKey,
    typeInstanceKey,
    effectful,
  };
  if (effectful) {
    lambdaCtx.currentHandler = {
      index: 1,
      type: ctx.effectsRuntime.handlerFrameType,
    };
  }

  expr.parameters.forEach((param, index) => {
    const binding = {
      kind: "local" as const,
      index: index + 1 + handlerOffset,
      type: env.base.paramTypes[index + handlerOffset]!,
      typeId: desc.parameters[index]!.type,
    };
    lambdaCtx.bindings.set(param.symbol, binding);
  });

  env.captures.forEach((capture) => {
    lambdaCtx.bindings.set(capture.symbol, {
      kind: "capture",
      envIndex: 0,
      envType: env.envType,
      envSuperType: env.base.interfaceType,
      fieldIndex: capture.fieldIndex,
      type: capture.wasmType,
      typeId: capture.typeId,
      mutable: capture.mutable,
    });
  });

  const body = compileExpr({
    exprId: expr.body,
    ctx,
    fnCtx: lambdaCtx,
    tailPosition: true,
    expectedResultTypeId: desc.returnType,
  });
  const returnWasmType = wasmTypeFor(desc.returnType, ctx);
  const shouldWrapOutcome =
    effectful &&
    binaryen.getExpressionType(body.expr) === returnWasmType;
  const functionBody = shouldWrapOutcome
    ? wrapValueInOutcome({
        valueExpr: body.expr,
        valueType: returnWasmType,
        ctx,
      })
    : body.expr;

  ctx.mod.addFunction(
    fnName,
    binaryen.createType(params as number[]),
    env.base.resultType,
    lambdaCtx.locals,
    functionBody
  );
};

export const compileLambdaExpr = (
  expr: HirLambdaExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const lambdaTypeId = getRequiredExprType(expr.id, ctx, typeInstanceKey);
  const base = getClosureTypeInfo(lambdaTypeId, ctx);
  const lambdaInstanceKey = formatLambdaInstanceKey(expr.id, fnCtx.instanceKey);
  const key = makeLambdaKey(expr.id, ctx, fnCtx.instanceKey);

  let envInfo = ctx.lambdaEnvs.get(key);
  if (!envInfo) {
    const captures: LambdaCaptureInfo[] =
      expr.captures?.map((capture, index) => {
        const bindingTypeId = fnCtx.bindings.get(capture.symbol)?.typeId;
        const typeId =
          typeof bindingTypeId === "number"
            ? bindingTypeId
            : getSymbolTypeId(capture.symbol, ctx);
        return {
          symbol: capture.symbol,
          typeId,
          wasmType: wasmTypeFor(typeId, ctx),
          mutable: capture.mutable,
          fieldIndex: index + 1,
        };
      }) ?? [];
    const envType = defineLambdaEnvType({
      base,
      captures,
      expr,
      ctx,
      instanceKey: lambdaInstanceKey,
    });
    envInfo = { envType, captures, base, typeId: lambdaTypeId };
    ctx.lambdaEnvs.set(key, envInfo);
  }
  const env = envInfo as LambdaEnvInfo;

  let fnName = ctx.lambdaFunctions.get(key);
  if (!fnName) {
    fnName = makeLambdaFunctionName({
      expr,
      ctx,
      instanceKey: lambdaInstanceKey,
    });
    emitLambdaFunction({
      expr,
      ctx,
      env,
      fnName,
      instanceKey: lambdaInstanceKey,
      typeInstanceKey,
      compileExpr,
    });
    ctx.lambdaFunctions.set(key, fnName);
  }

  const captureValues =
    expr.captures?.map((capture) => {
      const binding = getRequiredBinding(capture.symbol, ctx, fnCtx);
      return loadBindingValue(binding, ctx);
    }) ?? [];

  const closure = initStruct(ctx.mod, env.envType, [
    refFunc(ctx.mod, fnName, base.fnRefType),
    ...captureValues,
  ]);

  return { expr: closure, usedReturnCall: false };
};
