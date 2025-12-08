import binaryen from "binaryen";
import {
  callRef,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import { unboxOutcomeValue } from "./outcome-values.js";
import type { CodegenContext, FunctionMetadata } from "../context.js";
import type { EffectRuntime } from "./runtime-abi.js";
import { wasmTypeFor } from "../types.js";

export const MSGPACK_WRITE_VALUE = "__voyd_msgpack_write_value";
export const MSGPACK_WRITE_EFFECT = "__voyd_msgpack_write_effect";
export const MSGPACK_READ_VALUE = "__voyd_msgpack_read_value";

export const VALUE_TAG = {
  none: 0,
  i32: 1,
} as const;

export const EFFECT_RESULT_STATUS = {
  value: 0,
  effect: 1,
} as const;

export const MIN_EFFECT_BUFFER_SIZE = 4 * 1024;

type MsgPackImports = {
  writeValue: string;
  writeEffect: string;
  readValue: string;
};

type EffectOpSignature = {
  effectId: number;
  opId: number;
  params: readonly binaryen.Type[];
  returnType: binaryen.Type;
  argsType?: binaryen.Type;
  label: string;
};

const stateFor = <T>(ctx: CodegenContext, key: string, init: () => T): T => {
  const container = ctx as unknown as Record<string, unknown>;
  if (container[key]) return container[key] as T;
  const value = init();
  container[key] = value;
  return value;
};

export const ensureLinearMemory = (ctx: CodegenContext): void => {
  stateFor(ctx, "__voyd_effects_memory__", () => {
    ctx.mod.setMemory(1, 1, "memory");
    return true;
  });
};

export const ensureMsgPackImports = (ctx: CodegenContext): MsgPackImports =>
  stateFor(ctx, "__voyd_msgpack_imports__", () => {
    const params = binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    ctx.mod.addFunctionImport(
      MSGPACK_WRITE_VALUE,
      "env",
      MSGPACK_WRITE_VALUE,
      params,
      binaryen.i32
    );

    const effectParams = binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    ctx.mod.addFunctionImport(
      MSGPACK_WRITE_EFFECT,
      "env",
      MSGPACK_WRITE_EFFECT,
      effectParams,
      binaryen.i32
    );

    const readParams = binaryen.createType([binaryen.i32, binaryen.i32]);
    ctx.mod.addFunctionImport(
      MSGPACK_READ_VALUE,
      "env",
      MSGPACK_READ_VALUE,
      readParams,
      binaryen.i32
    );

    return {
      writeValue: MSGPACK_WRITE_VALUE,
      writeEffect: MSGPACK_WRITE_EFFECT,
      readValue: MSGPACK_READ_VALUE,
    };
  });

const supportedValueTag = ({
  wasmType,
  label,
}: {
  wasmType: binaryen.Type;
  label: string;
}): number => {
  if (wasmType === binaryen.none) return VALUE_TAG.none;
  if (wasmType === binaryen.i32) return VALUE_TAG.i32;
  throw new Error(
    `unsupported value type ${wasmType} for host boundary (${label})`
  );
};

export const collectEffectOperationSignatures = (
  ctx: CodegenContext
): EffectOpSignature[] =>
  stateFor(ctx, "__voyd_effect_op_sigs__", () => {
    const signatures: EffectOpSignature[] = [];
    ctx.binding.effects.forEach((effect, effectId) => {
      effect.operations.forEach((op, opId) => {
        const signature = ctx.typing.functions.getSignature(op.symbol);
        if (!signature) {
          throw new Error("missing effect operation signature");
        }
        const params = signature.parameters.map((param) =>
          wasmTypeFor(param.type, ctx)
        );
        const returnType = wasmTypeFor(signature.returnType, ctx);
        const label = `${effect.name}.${op.name}`;
        params.forEach((paramType) =>
          supportedValueTag({ wasmType: paramType, label })
        );
        supportedValueTag({ wasmType: returnType, label });
        signatures.push({
          effectId,
          opId,
          params,
          returnType,
          argsType: ctx.effectLowering.argsTypes.get(op.symbol),
          label,
        });
      });
    });
    return signatures;
  });

const trapOnNonZero = (
  value: binaryen.ExpressionRef,
  ctx: CodegenContext
): binaryen.ExpressionRef =>
  ctx.mod.if(
    ctx.mod.i32.ne(value, ctx.mod.i32.const(0)),
    ctx.mod.unreachable(),
    ctx.mod.nop()
  );

let hostSigCounter = 0;
const bin = binaryen as unknown as AugmentedBinaryen;
const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => {
  const tempName = `__voyd_host_sig_${hostSigCounter++}`;
  const temp = ctx.mod.addFunction(
    tempName,
    binaryen.createType(params as number[]),
    result,
    [],
    ctx.mod.nop()
  );
  const refType = bin._BinaryenTypeFromHeapType(
    bin._BinaryenFunctionGetType(temp),
    false
  );
  ctx.mod.removeFunction(tempName);
  return refType;
};

const encodeEffectArgs = ({
  ctx,
  runtime,
  requestLocal,
  signatures,
  bufPtrLocal,
  effectIdExpr,
  opIdExpr,
  argsCountLocal,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  requestLocal: number;
  signatures: readonly EffectOpSignature[];
  bufPtrLocal: number;
  effectIdExpr: binaryen.ExpressionRef;
  opIdExpr: binaryen.ExpressionRef;
  argsCountLocal: number;
}): binaryen.ExpressionRef[] => {
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(argsCountLocal, ctx.mod.i32.const(0)),
  ];

  const request = ctx.mod.local.get(requestLocal, runtime.effectRequestType);
  const argsRef = runtime.requestArgs(request);

  signatures.forEach((sig) => {
    if (sig.params.length === 0) return;
    const matches = ctx.mod.i32.and(
      ctx.mod.i32.eq(effectIdExpr, ctx.mod.i32.const(sig.effectId)),
      ctx.mod.i32.eq(opIdExpr, ctx.mod.i32.const(sig.opId))
    );
    if (!sig.argsType) {
      ops.push(
        ctx.mod.if(
          matches,
          ctx.mod.local.set(argsCountLocal, ctx.mod.i32.const(0))
        )
      );
      return;
    }
    const typedArgs = refCast(ctx.mod, argsRef, sig.argsType);
    const stores = sig.params.map((paramType, index) => {
      if (paramType !== binaryen.i32) {
        return ctx.mod.unreachable();
      }
      return ctx.mod.i32.store(
        index * 4,
        4,
        ctx.mod.local.get(bufPtrLocal, binaryen.i32),
        structGetFieldValue({
          mod: ctx.mod,
          fieldIndex: index,
          fieldType: paramType,
          exprRef: typedArgs,
        })
      );
    });
    ops.push(
      ctx.mod.if(
        matches,
        ctx.mod.block(null, [
          ...stores,
          ctx.mod.local.set(
            argsCountLocal,
            ctx.mod.i32.const(sig.params.length)
          ),
        ])
      )
    );
  });

  return ops;
};

export const createHandleOutcome = ({
  ctx,
  runtime,
  valueType,
  signatures,
  imports,
  exportName = "handle_outcome",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  valueType: binaryen.Type;
  signatures: readonly EffectOpSignature[];
  imports: MsgPackImports;
  exportName?: string;
}): string => {
  const cache = stateFor<Map<number, string>>(
    ctx,
    "__voyd_handle_outcome_cache__",
    () => new Map()
  );
  const tag = supportedValueTag({ wasmType: valueType, label: exportName });
  const cached = cache.get(tag);
  if (cached) return cached;

  const name = `${ctx.moduleLabel}__handle_outcome_${cache.size}`;
  const params = binaryen.createType([
    runtime.outcomeType,
    binaryen.i32,
    binaryen.i32,
  ]);
  const locals: binaryen.Type[] = [
    runtime.effectRequestType, // requestLocal
    binaryen.i32, // argsCountLocal
    binaryen.i32, // tagLocal
  ];
  const outcomeLocal = 0;
  const bufPtrLocal = 1;
  const bufLenLocal = 2;
  const requestLocal = 3;
  const argsCountLocal = 4;
  const tagLocal = 5;

  const valueOps: binaryen.ExpressionRef[] = [
    trapOnNonZero(
      ctx.mod.call(
        imports.writeValue,
        [
          ctx.mod.i32.const(tag),
          tag === VALUE_TAG.none
            ? ctx.mod.i32.const(0)
            : unboxOutcomeValue({
                payload: runtime.outcomePayload(
                  ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
                ),
                valueType,
                ctx,
              }),
          ctx.mod.local.get(bufPtrLocal, binaryen.i32),
          ctx.mod.local.get(bufLenLocal, binaryen.i32),
        ],
        binaryen.i32
      ),
      ctx
    ),
    ctx.mod.return(
      runtime.makeEffectResult({
        status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
        cont: ctx.mod.ref.null(binaryen.anyref),
      })
    ),
  ];

  const effectIdExpr = runtime.requestEffectId(
    ctx.mod.local.get(requestLocal, runtime.effectRequestType)
  );
  const opIdExpr = runtime.requestOpId(
    ctx.mod.local.get(requestLocal, runtime.effectRequestType)
  );
  const argOps = encodeEffectArgs({
    ctx,
    runtime,
    requestLocal,
    signatures,
    bufPtrLocal,
    effectIdExpr,
    opIdExpr,
    argsCountLocal,
  });
  const effectOps: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(
      requestLocal,
      refCast(
        ctx.mod,
        runtime.outcomePayload(
          ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
        ),
        runtime.effectRequestType
      )
    ),
    ...argOps,
    trapOnNonZero(
      ctx.mod.call(
        imports.writeEffect,
        [
          runtime.requestEffectId(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          ),
          runtime.requestOpId(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          ),
          runtime.requestResumeKind(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          ),
          ctx.mod.local.get(bufPtrLocal, binaryen.i32),
          ctx.mod.local.get(argsCountLocal, binaryen.i32),
          ctx.mod.local.get(bufPtrLocal, binaryen.i32),
          ctx.mod.local.get(bufLenLocal, binaryen.i32),
        ],
        binaryen.i32
      ),
      ctx
    ),
    ctx.mod.return(
      runtime.makeEffectResult({
        status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.effect),
        cont: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
      })
    ),
  ];

  ctx.mod.addFunction(
    name,
    params,
    runtime.effectResultType,
    locals,
    ctx.mod.block(null, [
      ctx.mod.local.set(
        tagLocal,
        runtime.outcomeTag(
          ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
        )
      ),
      ctx.mod.if(
        ctx.mod.i32.eq(
          ctx.mod.local.get(tagLocal, binaryen.i32),
          ctx.mod.i32.const(EFFECT_RESULT_STATUS.value)
        ),
        ctx.mod.block(null, valueOps),
        ctx.mod.block(null, effectOps)
      ),
    ])
  );

  ctx.mod.addFunctionExport(name, exportName);
  cache.set(tag, name);
  return name;
};

export const createReadValue = ({
  ctx,
  imports,
  exportName = "read_value",
}: {
  ctx: CodegenContext;
  imports: MsgPackImports;
  exportName?: string;
}): string =>
  stateFor(ctx, "__voyd_read_value__", () => {
    const name = `${ctx.moduleLabel}__read_value`;
    const params = binaryen.createType([binaryen.i32, binaryen.i32]);
    ctx.mod.addFunction(
      name,
      params,
      binaryen.i32,
      [],
      ctx.mod.call(
        imports.readValue,
        [
          ctx.mod.local.get(0, binaryen.i32),
          ctx.mod.local.get(1, binaryen.i32),
        ],
        binaryen.i32
      )
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

export const ensureEffectResultAccessors = ({
  ctx,
  runtime,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): { status: string; cont: string } => {
  const status = stateFor(ctx, "__voyd_effect_status__", () => {
    const name = `${ctx.moduleLabel}__effect_status`;
    ctx.mod.addFunction(
      name,
      binaryen.createType([runtime.effectResultType]),
      binaryen.i32,
      [],
      runtime.effectResultStatus(
        ctx.mod.local.get(0, runtime.effectResultType)
      )
    );
    ctx.mod.addFunctionExport(name, "effect_status");
    return name;
  });

  const cont = stateFor(ctx, "__voyd_effect_cont__", () => {
    const name = `${ctx.moduleLabel}__effect_cont`;
    ctx.mod.addFunction(
      name,
      binaryen.createType([runtime.effectResultType]),
      binaryen.anyref,
      [],
      runtime.effectResultCont(
        ctx.mod.local.get(0, runtime.effectResultType)
      )
    );
    ctx.mod.addFunctionExport(name, "effect_cont");
    return name;
  });

  return { status, cont };
};

export const createEffectfulEntry = ({
  ctx,
  runtime,
  meta,
  handleOutcome,
  exportName,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  handleOutcome: string;
  exportName: string;
}): string => {
  if (meta.paramTypes.length > 1) {
    throw new Error(
      `effectful exports with parameters are not supported yet (${exportName})`
    );
  }
  const name = `${ctx.moduleLabel}__${exportName}`;
  const params = binaryen.createType([binaryen.i32, binaryen.i32]);
  ctx.mod.addFunction(
    name,
    params,
    runtime.effectResultType,
    [],
    ctx.mod.call(
      handleOutcome,
      [
        ctx.mod.call(
          meta.wasmName,
          [ctx.mod.ref.null(runtime.handlerFrameType)],
          runtime.outcomeType
        ),
        ctx.mod.local.get(0, binaryen.i32),
        ctx.mod.local.get(1, binaryen.i32),
      ],
      runtime.effectResultType
    )
  );
  ctx.mod.addFunctionExport(name, exportName);
  return name;
};

export const createResumeContinuation = ({
  ctx,
  runtime,
  signatures,
  exportName = "resume_continuation",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  exportName?: string;
}): string =>
  stateFor(ctx, "__voyd_resume_continuation__", () => {
    const name = `${ctx.moduleLabel}__resume_continuation`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.tailGuardType,
      runtime.continuationType,
    ];
    const requestLocal = 0;
    const valueLocal = 1;
    const guardLocal = 2;
    const contLocal = 3;
    const effectIdExpr = runtime.requestEffectId(
      ctx.mod.local.get(requestLocal, runtime.effectRequestType)
    );
    const opIdExpr = runtime.requestOpId(
      ctx.mod.local.get(requestLocal, runtime.effectRequestType)
    );

    const guard = ctx.mod.local.get(guardLocal, runtime.tailGuardType);
    const guardInit = ctx.mod.if(
      ctx.mod.ref.is_null(guard),
      ctx.mod.local.set(guardLocal, runtime.makeTailGuard()),
      ctx.mod.nop()
    );
    const guardOps = [
    ctx.mod.if(
      ctx.mod.i32.and(
        ctx.mod.i32.gt_u(
          runtime.tailGuardExpected(guard),
          ctx.mod.i32.const(0)
        ),
        ctx.mod.i32.ge_u(
          runtime.tailGuardObserved(guard),
          runtime.tailGuardExpected(guard)
        )
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop()
    ),
    runtime.bumpTailGuardObserved(guard),
  ];

    const contRef = ctx.mod.local.get(contLocal, runtime.continuationType);
    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.and(
        ctx.mod.i32.eq(effectIdExpr, ctx.mod.i32.const(sig.effectId)),
        ctx.mod.i32.eq(opIdExpr, ctx.mod.i32.const(sig.opId))
      );
      const paramsForRef =
        sig.returnType === binaryen.none
          ? [binaryen.anyref]
          : [binaryen.anyref, sig.returnType];
      const fnRefType = functionRefType({
        params: paramsForRef,
        result: runtime.outcomeType,
        ctx,
      });
      const operands =
        sig.returnType === binaryen.none
          ? [runtime.continuationEnv(contRef)]
          : [
              runtime.continuationEnv(contRef),
              ctx.mod.local.get(valueLocal, sig.returnType),
            ];
      const call = callRef(
        ctx.mod,
        refCast(ctx.mod, runtime.continuationFn(contRef), fnRefType),
        operands as number[],
        runtime.outcomeType
      );
      return ctx.mod.if(matches, ctx.mod.return(call));
    });

    ctx.mod.addFunction(
      name,
      params,
      runtime.outcomeType,
      locals,
      ctx.mod.block(null, [
        ctx.mod.local.set(
          guardLocal,
          runtime.requestTailGuard(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          )
        ),
        ctx.mod.local.set(
          contLocal,
          runtime.requestContinuation(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          )
        ),
        guardInit,
        ...guardOps,
        ...branches,
        ctx.mod.return(
          runtime.makeOutcomeEffect(
            ctx.mod.local.get(requestLocal, runtime.effectRequestType)
          )
        ),
      ])
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });

export const createResumeEffectful = ({
  ctx,
  runtime,
  imports,
  handleOutcome,
  resumeContinuation,
  exportName = "resume_effectful",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  imports: MsgPackImports;
  handleOutcome: string;
  resumeContinuation: string;
  exportName?: string;
}): string =>
  stateFor(ctx, "__voyd_resume_effectful__", () => {
    const name = `${ctx.moduleLabel}__resume_effectful`;
    const params = binaryen.createType([
      runtime.effectRequestType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [];
    const contParam = 0;
    const bufPtrParam = 1;
    const bufLenParam = 2;

    ctx.mod.addFunction(
      name,
      params,
      runtime.effectResultType,
      locals,
      ctx.mod.call(
        handleOutcome,
        [
          ctx.mod.call(
            resumeContinuation,
            [
              ctx.mod.local.get(contParam, runtime.effectRequestType),
              ctx.mod.call(
                imports.readValue,
                [
                  ctx.mod.local.get(bufPtrParam, binaryen.i32),
                  ctx.mod.local.get(bufLenParam, binaryen.i32),
                ],
                binaryen.i32
              ),
            ],
            runtime.outcomeType
          ),
          ctx.mod.local.get(bufPtrParam, binaryen.i32),
          ctx.mod.local.get(bufLenParam, binaryen.i32),
        ],
        runtime.effectResultType
      )
    );
    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
