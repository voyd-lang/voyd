import binaryen from "binaryen";
import {
  defineStructType,
  initStruct,
  refFunc,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
} from "../context.js";
import { effectsFacade } from "../effects/facade.js";
import { allocateTempLocal, loadBindingValue } from "../locals.js";
import { getRequiredExprType, wasmTypeFor } from "../types.js";
import {
  handlerCleanupOps,
  pushHandlerScope,
  popHandlerScope,
} from "../effects/handler-stack.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { RESUME_KIND, type ResumeKind } from "../effects/runtime-abi.js";
import type { HirEffectHandlerExpr } from "../../semantics/hir/index.js";
import type { TypeId } from "../../semantics/ids.js";
import {
  handlerClauseContinuationTempId,
  handlerClauseTailGuardTempId,
} from "../effects/effect-lowering/handler-clause-temp-ids.js";

const bin = binaryen as unknown as AugmentedBinaryen;

type HandlerCodegenState = {
  envLayouts: Map<
    number,
    {
      envType: binaryen.Type;
      fields: ClauseEnvField[];
    }
  >;
  clauseFnRefTypes: Map<string, binaryen.Type>;
};

const HANDLER_STATE_KEY = Symbol("voyd.effects.effectHandler.codegenState");

const handlerState = (ctx: CodegenContext): HandlerCodegenState => {
  const memo = ctx.effectsState.memo;
  const existing = memo.get(HANDLER_STATE_KEY) as HandlerCodegenState | undefined;
  if (existing) return existing;
  const created: HandlerCodegenState = {
    envLayouts: new Map(),
    clauseFnRefTypes: new Map(),
  };
  memo.set(HANDLER_STATE_KEY, created);
  return created;
};

type ClauseEnvField = {
  symbol: number;
  typeId: number;
  wasmType: binaryen.Type;
  fieldIndex: number;
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const currentHandlerValue = (
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (!fnCtx.currentHandler) {
    return ctx.mod.ref.null(ctx.effectsRuntime.handlerFrameType);
  }
  return ctx.mod.local.get(fnCtx.currentHandler.index, fnCtx.currentHandler.type);
};

const buildClauseEnv = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirEffectHandlerExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  envType: binaryen.Type;
  envValue: binaryen.ExpressionRef;
  fields: ClauseEnvField[];
} => {
  const state = handlerState(ctx);
  const cached = state.envLayouts.get(expr.id);
  const layout =
    cached ??
    (() => {
      const captured = Array.from(fnCtx.bindings.entries())
        .map(([symbol, binding]) => {
          const typeId =
            binding.typeId ??
            ctx.module.types.getValueType(symbol) ??
            ctx.program.primitives.unknown;
          return {
            symbol,
            typeId,
            wasmType: binding.type,
          };
        })
        .sort((a, b) => a.symbol - b.symbol)
        .map((field, fieldIndex) => ({ ...field, fieldIndex }));

      const envType = defineStructType(ctx.mod, {
        name: `voydHandlerEnv_${sanitize(ctx.moduleLabel)}_${expr.id}`,
        fields: captured.map((field) => ({
          name: `c${field.fieldIndex}`,
          type: field.wasmType,
          mutable: false,
        })),
        final: true,
      });

      const next = { envType, fields: captured };
      state.envLayouts.set(expr.id, next);
      return next;
    })();

  if (layout.fields.length === 0) {
    return {
      envType: layout.envType,
      envValue: ctx.mod.ref.null(layout.envType),
      fields: [],
    };
  }

  const envValue = initStruct(
    ctx.mod,
    layout.envType,
    layout.fields.map((field) => {
      const binding = fnCtx.bindings.get(field.symbol);
      if (!binding) {
        throw new Error("missing handler env binding");
      }
      return loadBindingValue(binding, ctx);
    }) as number[]
  );
  return { envType: layout.envType, envValue, fields: layout.fields };
};

const emitClauseFunction = ({
  expr,
  clauseIndex,
  env,
  ctx,
  handlerResumeKind,
  compileExpr,
}: {
  expr: HirEffectHandlerExpr;
  clauseIndex: number;
  env: ReturnType<typeof buildClauseEnv>;
  ctx: CodegenContext;
  handlerResumeKind: ResumeKind;
  compileExpr: ExpressionCompiler;
}): { fnName: string; fnRefType: binaryen.Type } => {
  const fnName = `${ctx.moduleLabel}__handler_${expr.id}_${clauseIndex}`;
  const state = handlerState(ctx);
  const cachedRefType = state.clauseFnRefTypes.get(fnName);
  if (cachedRefType) {
    return { fnName, fnRefType: cachedRefType };
  }

  const clause = expr.handlers[clauseIndex]!;
  const signature = ctx.program.functions.getSignature(ctx.moduleId, clause.operation);
  if (!signature) {
    throw new Error("missing effect operation signature for handler clause");
  }
  const params = [
    ctx.effectsRuntime.handlerFrameType,
    binaryen.anyref,
    ctx.effectsRuntime.effectRequestType,
  ];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [],
    nextLocalIndex: params.length,
    returnTypeId: signature.returnType,
    instanceId: undefined,
    typeInstanceId: undefined,
    effectful: true,
    currentHandler: { index: 0, type: ctx.effectsRuntime.handlerFrameType },
  };

  env.fields.forEach((field) => {
    const local = allocateTempLocal(field.wasmType, fnCtx, field.typeId);
    fnCtx.bindings.set(field.symbol, {
      ...local,
      kind: "local",
      typeId: field.typeId,
    });
  });

  const initOps: binaryen.ExpressionRef[] = env.fields.map((field) =>
    ctx.mod.local.set(
      field.fieldIndex + params.length,
      structGetFieldValue({
        mod: ctx.mod,
        fieldIndex: field.fieldIndex,
        fieldType: field.wasmType,
        exprRef: refCast(
          ctx.mod,
          ctx.mod.local.get(1, binaryen.anyref),
          env.envType
        ),
      })
    )
  );

  const requestLocal = allocateTempLocal(
    ctx.effectsRuntime.effectRequestType,
    fnCtx
  );
  initOps.push(
    ctx.mod.local.set(
      requestLocal.index,
      ctx.mod.local.get(2, ctx.effectsRuntime.effectRequestType)
    )
  );

  const continuationLocal = allocateTempLocal(
    ctx.effectsRuntime.continuationType,
    fnCtx
  );
  initOps.push(
    ctx.mod.local.set(
      continuationLocal.index,
      ctx.effectsRuntime.requestContinuation(
        ctx.mod.local.get(requestLocal.index, requestLocal.type)
      )
    )
  );
  const tailGuardLocal = allocateTempLocal(
    ctx.effectsRuntime.tailGuardType,
    fnCtx
  );
  initOps.push(
    ctx.mod.local.set(
      tailGuardLocal.index,
      ctx.effectsRuntime.requestTailGuard(
        ctx.mod.local.get(requestLocal.index, requestLocal.type)
      )
    )
  );

  fnCtx.tempLocals.set(
    handlerClauseContinuationTempId({ handlerExprId: expr.id, clauseIndex }),
    continuationLocal
  );
  fnCtx.tempLocals.set(
    handlerClauseTailGuardTempId({ handlerExprId: expr.id, clauseIndex }),
    tailGuardLocal
  );

  if (clause.parameters[0]) {
    const continuationTypeId =
      ctx.module.types.getValueType(clause.parameters[0].symbol) ??
      ctx.program.primitives.unknown;
    const continuationDesc = ctx.program.types.getTypeDesc(continuationTypeId);
    const resumeTypeId =
      continuationDesc.kind === "function"
        ? continuationDesc.parameters[0]?.type ?? ctx.program.primitives.void
        : signature.returnType;
    const continuationBinding = allocateTempLocal(
      wasmTypeFor(continuationTypeId, ctx),
      fnCtx,
      continuationTypeId
    );
    initOps.push(
      ctx.mod.local.set(
        continuationBinding.index,
        ctx.mod.ref.null(continuationBinding.type)
      )
    );
    fnCtx.bindings.set(clause.parameters[0].symbol, {
      ...continuationBinding,
      kind: "local",
      typeId: continuationTypeId,
    });
    fnCtx.continuations = new Map([
      [
        clause.parameters[0].symbol,
        {
          continuationLocal,
          tailGuardLocal,
          resumeKind: handlerResumeKind,
          resumeTypeId,
        },
      ],
    ]);
  }

  const argsType = ctx.effectLowering.argsTypes.get(clause.operation);
  if (!argsType && signature.parameters.length > 0) {
    throw new Error("missing effect args type for handler clause");
  }
  const argsRef = ctx.effectsRuntime.requestArgs(
    ctx.mod.local.get(requestLocal.index, requestLocal.type)
  );

  clause.parameters.slice(clause.parameters[0] ? 1 : 0).forEach((param, index) => {
    const typeId =
      ctx.module.types.getValueType(param.symbol) ??
      signature.parameters[index]?.typeId ??
      ctx.program.primitives.unknown;
    const wasmType = wasmTypeFor(typeId, ctx);
    const binding = allocateTempLocal(wasmType, fnCtx, typeId);
    initOps.push(
      ctx.mod.local.set(
        binding.index,
        !argsType
          ? ctx.mod.ref.null(wasmType)
          : structGetFieldValue({
              mod: ctx.mod,
              fieldIndex: index,
              fieldType: wasmType,
              exprRef: refCast(ctx.mod, argsRef, argsType),
            })
      )
    );
    fnCtx.bindings.set(param.symbol, { ...binding, kind: "local", typeId });
  });

  const expectedClauseReturnTypeId =
    clause.parameters[0] &&
    typeof ctx.module.types.getValueType(clause.parameters[0].symbol) === "number"
      ? ((): TypeId => {
          const continuationTypeId = ctx.module.types.getValueType(
            clause.parameters[0].symbol
          ) as TypeId;
          const desc = ctx.program.types.getTypeDesc(continuationTypeId);
          return desc.kind === "function" ? desc.returnType : signature.returnType;
        })()
      : signature.returnType;
  const body = compileExpr({
    exprId: clause.body,
    ctx,
    fnCtx,
    tailPosition: true,
    expectedResultTypeId: expectedClauseReturnTypeId,
  });
  const returnWasmType = wasmTypeFor(expectedClauseReturnTypeId, ctx);
  const wrapped =
    binaryen.getExpressionType(body.expr) === returnWasmType
      ? wrapValueInOutcome({
          valueExpr: body.expr,
          valueType: returnWasmType,
          ctx,
        })
      : body.expr;

  const resultLocal =
    handlerResumeKind === RESUME_KIND.tail
      ? allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx)
      : undefined;
  const bodyBlock = ctx.mod.block(
    null,
    [
      ...initOps,
      resultLocal
        ? ctx.mod.local.set(resultLocal.index, wrapped)
        : wrapped,
      ...(handlerResumeKind === RESUME_KIND.tail && resultLocal
        ? [
            ctx.mod.if(
              ctx.mod.i32.ne(
                ctx.effectsRuntime.tailGuardObserved(
                  ctx.mod.local.get(tailGuardLocal.index, tailGuardLocal.type)
                ),
                ctx.effectsRuntime.tailGuardExpected(
                  ctx.mod.local.get(tailGuardLocal.index, tailGuardLocal.type)
                )
              ),
              ctx.mod.unreachable(),
              ctx.mod.nop()
            ),
            ctx.mod.local.get(resultLocal.index, resultLocal.type),
          ]
        : []),
    ],
    ctx.effectsRuntime.outcomeType
  );
  const fnRef = ctx.mod.addFunction(
    fnName,
    binaryen.createType(params as number[]),
    ctx.effectsRuntime.outcomeType,
    fnCtx.locals,
    bodyBlock
  );
  const heapType = bin._BinaryenFunctionGetType(fnRef);
  const fnRefType = bin._BinaryenTypeFromHeapType(heapType, false);
  state.clauseFnRefTypes.set(fnName, fnRefType);
  return { fnName, fnRefType };
};

export const compileEffectHandlerExpr = (
  expr: HirEffectHandlerExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: number
): CompiledExpression => {
  const handlerInfo = effectsFacade(ctx).handler(expr.id);
  if (!handlerInfo) {
    throw new Error("missing handler metadata for effect handler expression");
  }
  if (!fnCtx.currentHandler) {
    throw new Error("effect handler requires an effectful function context");
  }

  const env = buildClauseEnv({ expr, ctx, fnCtx });
  const prevHandlerLocal = allocateTempLocal(
    ctx.effectsRuntime.handlerFrameType,
    fnCtx
  );
  const headLocal = allocateTempLocal(
    ctx.effectsRuntime.handlerFrameType,
    fnCtx
  );
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(headLocal.index, currentHandlerValue(ctx, fnCtx)),
  ];

  const head = () => ctx.mod.local.get(headLocal.index, headLocal.type);
  const handlerAlreadyInstalled = ctx.mod.if(
    ctx.mod.ref.is_null(head()),
    ctx.mod.i32.const(0),
    ctx.mod.i32.eq(
      ctx.effectsRuntime.handlerLabel(head()),
      ctx.mod.i32.const(expr.id)
    )
  );

  const walkPrev = (cursor: binaryen.ExpressionRef): binaryen.ExpressionRef =>
    ctx.effectsRuntime.handlerPrev(
      refCast(ctx.mod, cursor, ctx.effectsRuntime.handlerFrameType)
    );

  const prevFromInstalled = (() => {
    let cursor: binaryen.ExpressionRef = head();
    for (let index = 0; index < handlerInfo.clauses.length; index += 1) {
      cursor = walkPrev(cursor);
    }
    return refCast(ctx.mod, cursor, ctx.effectsRuntime.handlerFrameType);
  })();

  const installFromScratch = (() => {
    let current = head();
    const installOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(prevHandlerLocal.index, current),
    ];
    handlerInfo.clauses.forEach((clause, index) => {
      const { effectId, opId, resumeKind } = effectsFacade(ctx).effectOpIds(
        clause.operation
      );
      const { fnName, fnRefType } = emitClauseFunction({
        expr,
        clauseIndex: index,
        env,
        ctx,
        handlerResumeKind: resumeKind,
        compileExpr,
      });
      current = ctx.effectsRuntime.makeHandlerFrame({
        prev: current,
        effectId: ctx.mod.i32.const(effectId),
        opId: ctx.mod.i32.const(opId),
        resumeKind: ctx.mod.i32.const(resumeKind),
        clauseFn: refFunc(ctx.mod, fnName, fnRefType),
        clauseEnv: env.envValue,
        tailExpected:
          resumeKind === RESUME_KIND.tail
            ? ctx.mod.i32.const(1)
            : ctx.mod.i32.const(0),
        label: ctx.mod.i32.const(expr.id),
      });
    });
    installOps.push(
      ctx.mod.local.set(fnCtx.currentHandler.index, current)
    );
    return ctx.mod.block(null, installOps, binaryen.none);
  })();

  ops.push(
    ctx.mod.if(
      handlerAlreadyInstalled,
      ctx.mod.local.set(prevHandlerLocal.index, prevFromInstalled),
      installFromScratch
    )
  );
  pushHandlerScope(fnCtx, { prevHandler: prevHandlerLocal, label: expr.id });

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const body = compileExpr({
    exprId: expr.body,
    ctx,
    fnCtx,
    tailPosition,
    expectedResultTypeId,
  });
  const resultType = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultWasmType = wasmTypeFor(resultType, ctx);
  const resultLocal =
    resultWasmType === binaryen.none
      ? undefined
      : allocateTempLocal(resultWasmType, fnCtx, resultType);
  if (resultLocal) {
    ops.push(ctx.mod.local.set(resultLocal.index, body.expr));
  } else {
    ops.push(body.expr);
  }

  if (typeof expr.finallyBranch === "number") {
    const finallyExpr = compileExpr({
      exprId: expr.finallyBranch,
      ctx,
      fnCtx,
      tailPosition: false,
      expectedResultTypeId,
    });
    const finalType = binaryen.getExpressionType(finallyExpr.expr);
    if (finalType !== binaryen.none) {
      ops.push(ctx.mod.drop(finallyExpr.expr));
    } else {
      ops.push(finallyExpr.expr);
    }
  }

  const cleanup = handlerCleanupOps({ ctx, fnCtx });
  popHandlerScope(fnCtx);
  ops.push(...cleanup);
  if (resultLocal) {
    ops.push(ctx.mod.local.get(resultLocal.index, resultLocal.type));
  }

  return {
    expr: ctx.mod.block(
      null,
      ops,
      resultWasmType
    ),
    usedReturnCall: body.usedReturnCall,
  };
};
