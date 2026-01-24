import binaryen from "binaryen";
import {
  refCast,
  refTest,
} from "@voyd/lib/binaryen-gc/index.js";
import { wasmTypeFor } from "../../types.js";
import { getOutcomeValueBoxType, unboxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { EFFECT_RESULT_STATUS } from "./constants.js";
import { buildEffectRequestMsgPack } from "./effect-request-msgpack.js";
import { ensureMsgPackFunctions } from "./msgpack.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";

const HANDLE_OUTCOME_DYNAMIC_KEY = Symbol("voyd.effects.hostBoundary.handleOutcomeDynamic");

const trapOnNegative = (
  value: binaryen.ExpressionRef,
  ctx: CodegenContext
): binaryen.ExpressionRef =>
  ctx.mod.if(
    ctx.mod.i32.lt_s(value, ctx.mod.i32.const(0)),
    ctx.mod.unreachable(),
    ctx.mod.nop()
  );

export const createHandleOutcomeDynamic = ({
  ctx,
  runtime,
  signatures,
  exportName = "handle_outcome",
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  signatures: readonly EffectOpSignature[];
  exportName?: string;
}): string =>
  stateFor(ctx, HANDLE_OUTCOME_DYNAMIC_KEY, () => {
    const msgpack = ensureMsgPackFunctions(ctx);
    const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);

    const name = `${ctx.moduleLabel}__handle_outcome_dynamic`;
    const params = binaryen.createType([runtime.outcomeType, binaryen.i32, binaryen.i32]);
    const locals: binaryen.Type[] = [
      runtime.effectRequestType, // requestLocal
      binaryen.i32, // payloadLenLocal
      binaryen.eqref, // payloadLocal
      msgpack.arrayWithCapacity.resultType, // arrayLocal
      msgpack.mapNew.resultType, // mapLocal
    ];
    const outcomeLocal = 0;
    const bufPtrLocal = 1;
    const bufLenLocal = 2;
    const requestLocal = 3;
    const payloadLenLocal = 4;
    const payloadLocal = 5;
    const arrayLocal = 6;
    const mapLocal = 7;

    const boxTypeI32 = getOutcomeValueBoxType({ valueType: binaryen.i32, ctx });
    const boxTypeI64 = getOutcomeValueBoxType({ valueType: binaryen.i64, ctx });
    const boxTypeF32 = getOutcomeValueBoxType({ valueType: binaryen.f32, ctx });
    const boxTypeF64 = getOutcomeValueBoxType({ valueType: binaryen.f64, ctx });
    const boxTypeMsgPack = getOutcomeValueBoxType({ valueType: msgPackType, ctx });

    const encodeToBuffer = (value: binaryen.ExpressionRef): binaryen.ExpressionRef =>
      ctx.mod.block(null, [
        ctx.mod.local.set(
          payloadLenLocal,
          ctx.mod.call(
            msgpack.encodeValue.wasmName,
            [
              value,
              ctx.mod.local.get(bufPtrLocal, binaryen.i32),
              ctx.mod.local.get(bufLenLocal, binaryen.i32),
            ],
            binaryen.i32
          )
        ),
        trapOnNegative(ctx.mod.local.get(payloadLenLocal, binaryen.i32), ctx),
      ]);

    const finishValue = (): binaryen.ExpressionRef =>
      ctx.mod.return(
        runtime.makeEffectResult({
          status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
          cont: ctx.mod.ref.null(binaryen.anyref),
          payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
        })
      );

    const valueOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(
        payloadLocal,
        runtime.outcomePayload(ctx.mod.local.get(outcomeLocal, runtime.outcomeType))
      ),
      ctx.mod.if(
        ctx.mod.ref.is_null(ctx.mod.local.get(payloadLocal, binaryen.eqref)),
        ctx.mod.block(null, [
          encodeToBuffer(ctx.mod.call(msgpack.packNull.wasmName, [], msgPackType)),
          finishValue(),
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI32
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.packI32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i32,
                  ctx,
                }),
              ],
              msgPackType
            )
          ),
          finishValue(),
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI64
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.packI64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i64,
                  ctx,
                }),
              ],
              msgPackType
            )
          ),
          finishValue(),
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF32
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.packF32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f32,
                  ctx,
                }),
              ],
              msgPackType
            )
          ),
          finishValue(),
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF64
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.packF64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f64,
                  ctx,
                }),
              ],
              msgPackType
            )
          ),
          finishValue(),
        ])
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeMsgPack
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            refCast(
              ctx.mod,
              unboxOutcomeValue({
                payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                valueType: msgPackType,
                ctx,
              }),
              msgPackType
            )
          ),
          finishValue(),
        ])
      ),
      ctx.mod.unreachable(),
    ];

    const opIndexExpr = runtime.requestOpIndex(
      ctx.mod.local.get(requestLocal, runtime.effectRequestType)
    );

    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        opIndexExpr,
        ctx.mod.i32.const(sig.opIndex)
      );
      const msgpackMap = buildEffectRequestMsgPack({
        sig,
        request: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        msgPackType,
        msgpack,
        arrayLocal,
        mapLocal,
        ctx,
        runtime,
      });

      const effectOps = ctx.mod.block(null, [
        encodeToBuffer(msgpackMap),
        ctx.mod.return(
          runtime.makeEffectResult({
            status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.effect),
            cont: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
            payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
          })
        ),
      ]);

      return ctx.mod.if(matches, effectOps);
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
      ...branches,
      ctx.mod.unreachable(),
    ];

    ctx.mod.addFunction(
      name,
      params,
      runtime.effectResultType,
      locals,
      ctx.mod.block(null, [
        ctx.mod.if(
          ctx.mod.i32.eq(
            runtime.outcomeTag(ctx.mod.local.get(outcomeLocal, runtime.outcomeType)),
            ctx.mod.i32.const(EFFECT_RESULT_STATUS.value)
          ),
          ctx.mod.block(null, valueOps),
          ctx.mod.block(null, effectOps)
        ),
      ])
    );

    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
