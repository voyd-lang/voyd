import binaryen from "binaryen";
import {
  refCast,
  refTest,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { getOutcomeValueBoxType, unboxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { EFFECT_RESULT_STATUS, VALUE_TAG } from "./constants.js";
import { supportedValueTag } from "./signatures.js";
import type { EffectOpSignature, MsgPackImports } from "./types.js";
import { stateFor } from "./state.js";

const HANDLE_OUTCOME_CACHE_KEY = Symbol("voyd.effects.hostBoundary.handleOutcomeCache");
const HANDLE_OUTCOME_DYNAMIC_KEY = Symbol("voyd.effects.hostBoundary.handleOutcomeDynamic");

const trapOnNonZero = (
  value: binaryen.ExpressionRef,
  ctx: CodegenContext
): binaryen.ExpressionRef =>
  ctx.mod.if(
    ctx.mod.i32.ne(value, ctx.mod.i32.const(0)),
    ctx.mod.unreachable(),
    ctx.mod.nop()
  );

const toWriteValueBits = ({
  value,
  valueType,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.i32) {
    return ctx.mod.i64.extend_s(value);
  }
  if (valueType === binaryen.i64) {
    return value;
  }
  if (valueType === binaryen.f32) {
    return ctx.mod.i64.extend_u(ctx.mod.i32.reinterpret(value));
  }
  if (valueType === binaryen.f64) {
    return ctx.mod.i64.reinterpret(value);
  }
  return ctx.mod.unreachable();
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
    if (sig.params.some((paramType) => paramType !== binaryen.i32)) {
      ops.push(
        ctx.mod.if(matches, ctx.mod.local.set(argsCountLocal, ctx.mod.i32.const(-1)))
      );
      return;
    }
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
          ctx.mod.local.set(argsCountLocal, ctx.mod.i32.const(sig.params.length)),
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
    HANDLE_OUTCOME_CACHE_KEY,
    () => new Map()
  );
  const tag = supportedValueTag({ wasmType: valueType, label: exportName });
  const cached = cache.get(tag);
  if (cached) return cached;

  const name = `${ctx.moduleLabel}__handle_outcome_${cache.size}`;
  const params = binaryen.createType([runtime.outcomeType, binaryen.i32, binaryen.i32]);
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
            ? ctx.mod.i64.const(0, 0)
            : toWriteValueBits({
                value: unboxOutcomeValue({
                  payload: runtime.outcomePayload(
                    ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
                  ),
                  valueType,
                  ctx,
                }),
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
        runtime.outcomePayload(ctx.mod.local.get(outcomeLocal, runtime.outcomeType)),
        runtime.effectRequestType
      )
    ),
    ...argOps,
    ctx.mod.if(
      ctx.mod.i32.lt_s(
        ctx.mod.local.get(argsCountLocal, binaryen.i32),
        ctx.mod.i32.const(0)
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop()
    ),
    trapOnNonZero(
      ctx.mod.call(
        imports.writeEffect,
        [
          runtime.requestEffectId(ctx.mod.local.get(requestLocal, runtime.effectRequestType)),
          runtime.requestOpId(ctx.mod.local.get(requestLocal, runtime.effectRequestType)),
          runtime.requestResumeKind(ctx.mod.local.get(requestLocal, runtime.effectRequestType)),
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
      ctx.mod.local.set(tagLocal, runtime.outcomeTag(ctx.mod.local.get(outcomeLocal, runtime.outcomeType))),
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

export const createHandleOutcomeDynamic = ({
  ctx,
  runtime,
  signatures,
  imports,
  exportName = "handle_outcome",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  imports: MsgPackImports;
  exportName?: string;
}): string =>
  stateFor(ctx, HANDLE_OUTCOME_DYNAMIC_KEY, () => {
    const name = `${ctx.moduleLabel}__handle_outcome_dynamic`;
    const params = binaryen.createType([runtime.outcomeType, binaryen.i32, binaryen.i32]);
    const locals: binaryen.Type[] = [
      runtime.effectRequestType, // requestLocal
      binaryen.i32, // argsCountLocal
      binaryen.i32, // outcomeTagLocal
      binaryen.eqref, // payloadLocal
    ];
    const outcomeLocal = 0;
    const bufPtrLocal = 1;
    const bufLenLocal = 2;
    const requestLocal = 3;
    const argsCountLocal = 4;
    const outcomeTagLocal = 5;
    const payloadLocal = 6;

    const boxTypeI32 = getOutcomeValueBoxType({ valueType: binaryen.i32, ctx });
    const boxTypeI64 = getOutcomeValueBoxType({ valueType: binaryen.i64, ctx });
    const boxTypeF32 = getOutcomeValueBoxType({ valueType: binaryen.f32, ctx });
    const boxTypeF64 = getOutcomeValueBoxType({ valueType: binaryen.f64, ctx });

    const payload = runtime.outcomePayload(
      ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
    );

    const valueOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(payloadLocal, payload),
      ctx.mod.if(
        ctx.mod.ref.is_null(ctx.mod.local.get(payloadLocal, binaryen.eqref)),
        ctx.mod.block(null, [
          trapOnNonZero(
            ctx.mod.call(
              imports.writeValue,
              [
                ctx.mod.i32.const(VALUE_TAG.none),
                ctx.mod.i64.const(0, 0),
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
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI32
        ),
        ctx.mod.block(null, [
          trapOnNonZero(
            ctx.mod.call(
              imports.writeValue,
              [
                ctx.mod.i32.const(VALUE_TAG.i32),
                toWriteValueBits({
                  value: unboxOutcomeValue({
                    payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                    valueType: binaryen.i32,
                    ctx,
                  }),
                  valueType: binaryen.i32,
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
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI64
        ),
        ctx.mod.block(null, [
          trapOnNonZero(
            ctx.mod.call(
              imports.writeValue,
              [
                ctx.mod.i32.const(VALUE_TAG.i64),
                toWriteValueBits({
                  value: unboxOutcomeValue({
                    payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                    valueType: binaryen.i64,
                    ctx,
                  }),
                  valueType: binaryen.i64,
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
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF32
        ),
        ctx.mod.block(null, [
          trapOnNonZero(
            ctx.mod.call(
              imports.writeValue,
              [
                ctx.mod.i32.const(VALUE_TAG.f32),
                toWriteValueBits({
                  value: unboxOutcomeValue({
                    payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                    valueType: binaryen.f32,
                    ctx,
                  }),
                  valueType: binaryen.f32,
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
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF64
        ),
        ctx.mod.block(null, [
          trapOnNonZero(
            ctx.mod.call(
              imports.writeValue,
              [
                ctx.mod.i32.const(VALUE_TAG.f64),
                toWriteValueBits({
                  value: unboxOutcomeValue({
                    payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                    valueType: binaryen.f64,
                    ctx,
                  }),
                  valueType: binaryen.f64,
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
        ])
      ),
      ctx.mod.unreachable(),
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
      ctx.mod.if(
        ctx.mod.i32.lt_s(
          ctx.mod.local.get(argsCountLocal, binaryen.i32),
          ctx.mod.i32.const(0)
        ),
        ctx.mod.unreachable(),
        ctx.mod.nop()
      ),
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
          outcomeTagLocal,
          runtime.outcomeTag(
            ctx.mod.local.get(outcomeLocal, runtime.outcomeType)
          )
        ),
        ctx.mod.if(
          ctx.mod.i32.eq(
            ctx.mod.local.get(outcomeTagLocal, binaryen.i32),
            ctx.mod.i32.const(EFFECT_RESULT_STATUS.value)
          ),
          ctx.mod.block(null, valueOps),
          ctx.mod.block(null, effectOps)
        ),
      ])
    );

    ctx.mod.addFunctionExport(name, exportName);
    supportedValueTag({ wasmType: binaryen.i32, label: exportName });
    supportedValueTag({ wasmType: binaryen.i64, label: exportName });
    supportedValueTag({ wasmType: binaryen.f32, label: exportName });
    supportedValueTag({ wasmType: binaryen.f64, label: exportName });
    supportedValueTag({ wasmType: binaryen.none, label: exportName });
    return name;
  });
