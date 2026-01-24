import binaryen from "binaryen";
import {
  refCast,
  refTest,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { emitStringLiteral } from "../../expressions/primitives.js";
import { findSerializerForType } from "../../serializer.js";
import { wasmTypeFor } from "../../types.js";
import { getOutcomeValueBoxType, unboxOutcomeValue } from "../outcome-values.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { EFFECT_RESULT_STATUS } from "./constants.js";
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

const packValueForType = ({
  value,
  typeId,
  msgPackType,
  msgpack,
  ctx,
  label,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  ctx: CodegenContext;
  label: string;
}): binaryen.ExpressionRef => {
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    if (serializer.formatId !== "msgpack") {
      throw new Error(`unsupported serializer format for ${label}: ${serializer.formatId}`);
    }
    return refCast(ctx.mod, value, msgPackType);
  }
  if (typeId === ctx.program.primitives.bool) {
    return ctx.mod.call(msgpack.packBool.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.i32) {
    return ctx.mod.call(msgpack.packI32.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.i64) {
    return ctx.mod.call(msgpack.packI64.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.f32) {
    return ctx.mod.call(msgpack.packF32.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.f64) {
    return ctx.mod.call(msgpack.packF64.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.void) {
    return ctx.mod.call(msgpack.packNull.wasmName, [], msgPackType);
  }
  return ctx.mod.block(null, [ctx.mod.unreachable()], msgPackType);
};

const buildArgsArray = ({
  sig,
  request,
  msgPackType,
  msgpack,
  arrayLocal,
  ctx,
  runtime,
}: {
  sig: EffectOpSignature;
  request: binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): binaryen.ExpressionRef => {
  const arrayType = msgpack.arrayWithCapacity.resultType;
  const argsCount = sig.paramTypeIds.length;
  const initArray = ctx.mod.call(
    msgpack.arrayWithCapacity.wasmName,
    [ctx.mod.i32.const(argsCount)],
    arrayType
  );
  const argsRef = runtime.requestArgs(request);
  const typedArgs = sig.argsType
    ? refCast(ctx.mod, argsRef, sig.argsType)
    : ctx.mod.ref.null(binaryen.eqref);

  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(arrayLocal, initArray)];
  sig.paramTypeIds.forEach((paramTypeId, index) => {
    const argValue = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: index,
      fieldType: sig.params[index]!,
      exprRef: typedArgs,
    });
    const msgpackValue = packValueForType({
      value: argValue,
      typeId: paramTypeId,
      msgPackType,
      msgpack,
      ctx,
      label: `${sig.label} arg${index}`,
    });
    ops.push(
      ctx.mod.local.set(
        arrayLocal,
        ctx.mod.call(
          msgpack.arrayPush.wasmName,
          [ctx.mod.local.get(arrayLocal, arrayType), msgpackValue],
          arrayType
        )
      )
    );
  });

  return ctx.mod.block(null, [
    ...ops,
    ctx.mod.local.get(arrayLocal, arrayType),
  ], arrayType);
};

const buildEffectRequestMap = ({
  request,
  argsArray,
  msgPackType,
  msgpack,
  mapLocal,
  ctx,
  runtime,
}: {
  request: binaryen.ExpressionRef;
  argsArray: binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  mapLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): binaryen.ExpressionRef => {
  const mapType = msgpack.mapNew.resultType;
  const mapInit = ctx.mod.call(msgpack.mapNew.wasmName, [], mapType);
  const effectId = runtime.requestEffectId(request);
  const opId = runtime.requestOpId(request);
  const opIndex = runtime.requestOpIndex(request);
  const resumeKind = runtime.requestResumeKind(request);
  const handle = runtime.requestHandle(request);
  const keys = {
    effectId: emitStringLiteral("effectId", ctx),
    opId: emitStringLiteral("opId", ctx),
    opIndex: emitStringLiteral("opIndex", ctx),
    resumeKind: emitStringLiteral("resumeKind", ctx),
    handle: emitStringLiteral("handle", ctx),
    args: emitStringLiteral("args", ctx),
  };

  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(mapLocal, mapInit),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.effectId,
          ctx.mod.call(msgpack.packI64.wasmName, [effectId], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.opId,
          ctx.mod.call(msgpack.packI32.wasmName, [opId], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.opIndex,
          ctx.mod.call(msgpack.packI32.wasmName, [opIndex], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.resumeKind,
          ctx.mod.call(msgpack.packI32.wasmName, [resumeKind], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.handle,
          ctx.mod.call(msgpack.packI32.wasmName, [handle], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.args,
          ctx.mod.call(msgpack.packArray.wasmName, [argsArray], msgPackType),
        ],
        mapType
      )
    ),
  ];

  return ctx.mod.block(null, [
    ...ops,
    ctx.mod.call(
      msgpack.packMap.wasmName,
      [ctx.mod.local.get(mapLocal, mapType)],
      msgPackType
    ),
  ], msgPackType);
};

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
      const argsArray = buildArgsArray({
        sig,
        request: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        msgPackType,
        msgpack,
        arrayLocal,
        ctx,
        runtime,
      });
      const msgpackMap = buildEffectRequestMap({
        request: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        argsArray,
        msgPackType,
        msgpack,
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
