import binaryen from "binaryen";
import {
  refCast,
  refTest,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import { wasmTypeFor } from "../../types.js";
import {
  getOutcomeValueBoxes,
  getOutcomeValueBoxType,
  unboxOutcomeValue,
} from "../outcome-values.js";
import type { CodegenContext, FunctionContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import {
  BoundarySchemaError,
  deriveBoundarySchema,
} from "../../boundary/schema.js";
import { packBoundaryValueAsMsgPack } from "../../boundary/msgpack-codec.js";
import { EFFECT_RESULT_STATUS } from "./constants.js";
import { buildEffectRequestMsgPack } from "./effect-request-msgpack.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { stateFor } from "./state.js";
import type { EffectOpSignature } from "./types.js";
import { findSerializerFormatForType } from "../../serializer.js";

const HANDLE_OUTCOME_DYNAMIC_KEY = Symbol(
  "voyd.effects.hostBoundary.handleOutcomeDynamic",
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
    const msgpack = ensureSelectedHostTransportProvider(ctx);
    const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);

    const name = `${ctx.moduleLabel}__handle_outcome_dynamic`;
    const params = binaryen.createType([
      runtime.outcomeType,
      binaryen.i32,
      binaryen.i32,
    ]);
    const locals: binaryen.Type[] = [
      runtime.effectRequestType, // requestLocal
      binaryen.i32, // opIndexLocal
      binaryen.i32, // payloadLenLocal
      binaryen.eqref, // payloadLocal
      msgpack.arrayWithCapacity.resultType, // arrayLocal
    ];
    const outcomeLocal = 0;
    const bufPtrLocal = 1;
    const bufLenLocal = 2;
    const requestLocal = 3;
    const opIndexLocal = 4;
    const payloadLenLocal = 5;
    const payloadLocal = 6;
    const arrayLocal = 7;
    const fnCtx: FunctionContext = {
      bindings: new Map(),
      tempLocals: new Map(),
      locals,
      nextLocalIndex: 8,
      returnTypeId: ctx.program.primitives.void,
      effectful: false,
    };

    const boxTypeI32 = getOutcomeValueBoxType({ valueType: binaryen.i32, ctx });
    const boxTypeBool = getOutcomeValueBoxType({
      valueType: binaryen.i32,
      typeId: ctx.program.primitives.bool,
      ctx,
    });
    const boxTypeI64 = getOutcomeValueBoxType({ valueType: binaryen.i64, ctx });
    const boxTypeF32 = getOutcomeValueBoxType({ valueType: binaryen.f32, ctx });
    const boxTypeF64 = getOutcomeValueBoxType({ valueType: binaryen.f64, ctx });
    const boxTypeMsgPack = getOutcomeValueBoxType({
      valueType: msgPackType,
      ctx,
    });
    const isFixedBox = ({
      valueType,
      typeId,
    }: {
      valueType: binaryen.Type;
      typeId?: number;
    }): boolean =>
      (typeId === undefined &&
        (valueType === binaryen.i32 ||
          valueType === binaryen.i64 ||
          valueType === binaryen.f32 ||
          valueType === binaryen.f64 ||
          valueType === msgPackType)) ||
      (typeId === ctx.program.primitives.bool && valueType === binaryen.i32);

    const matchesMarkedBox = ({
      boxType,
      markerFieldIndex,
      markerValue,
    }: {
      boxType: binaryen.Type;
      markerFieldIndex: number;
      markerValue: number;
    }): binaryen.ExpressionRef =>
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxType,
        ),
        ctx.mod.i32.eq(
          structGetFieldValue({
            mod: ctx.mod,
            fieldIndex: markerFieldIndex,
            fieldType: binaryen.i32,
            exprRef: refCast(
              ctx.mod,
              ctx.mod.local.get(payloadLocal, binaryen.eqref),
              boxType,
            ),
          }),
          ctx.mod.i32.const(markerValue),
        ),
        ctx.mod.i32.const(0),
      );

    const encodeToBuffer = (
      value: binaryen.ExpressionRef,
    ): binaryen.ExpressionRef =>
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
            binaryen.i32,
          ),
        ),
      ]);

    const finishValue = (): binaryen.ExpressionRef =>
      ctx.mod.return(
        runtime.makeEffectResult({
          status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
          cont: ctx.mod.ref.null(binaryen.anyref),
          payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
        }),
      );

    const valueOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(
        payloadLocal,
        runtime.outcomePayload(
          ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
        ),
      ),
      ctx.mod.if(
        ctx.mod.ref.is_null(ctx.mod.local.get(payloadLocal, binaryen.eqref)),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(msgpack.makeNull.wasmName, [], msgPackType),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        matchesMarkedBox({
          boxType: boxTypeBool,
          markerFieldIndex: 1,
          markerValue: ctx.program.primitives.bool,
        }),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.makeBool.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i32,
                  typeId: ctx.program.primitives.bool,
                  ctx,
                }),
              ],
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI32,
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.makeI32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i32,
                  ctx,
                }),
              ],
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeI64,
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.makeI64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.i64,
                  ctx,
                }),
              ],
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF32,
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.makeF32.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f32,
                  ctx,
                }),
              ],
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeF64,
        ),
        ctx.mod.block(null, [
          encodeToBuffer(
            ctx.mod.call(
              msgpack.makeF64.wasmName,
              [
                unboxOutcomeValue({
                  payload: ctx.mod.local.get(payloadLocal, binaryen.eqref),
                  valueType: binaryen.f64,
                  ctx,
                }),
              ],
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ctx.mod.if(
        refTest(
          ctx.mod,
          ctx.mod.local.get(payloadLocal, binaryen.eqref),
          boxTypeMsgPack,
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
              msgPackType,
            ),
          ),
          finishValue(),
        ]),
      ),
      ...getOutcomeValueBoxes(ctx)
        .filter(
          (box) =>
            typeof box.typeId === "number" &&
            box.valueType !== binaryen.none &&
            !isFixedBox(box),
        )
        .flatMap((box) => {
          const markerValue = box.markerValue;
          if (typeof markerValue !== "number") {
            return [];
          }
          const matchesBox = matchesMarkedBox({
            boxType: box.boxType,
            markerFieldIndex: box.abiTypes.length,
            markerValue,
          });
          const serializerFormat =
            box.serializer?.formatId ??
            findSerializerFormatForType(box.typeId!, ctx);
          if (serializerFormat) {
            if (serializerFormat !== "msgpack") {
              return [];
            }
            return [
              ctx.mod.if(
                matchesBox,
                ctx.mod.block(null, [
                  encodeToBuffer(
                    refCast(
                      ctx.mod,
                      unboxOutcomeValue({
                        payload: ctx.mod.local.get(
                          payloadLocal,
                          binaryen.eqref,
                        ),
                        valueType: box.valueType,
                        typeId: box.typeId,
                        ctx,
                      }),
                      msgPackType,
                    ),
                  ),
                  finishValue(),
                ]),
              ),
            ];
          }
          try {
            const schema = deriveBoundarySchema({
              typeId: box.typeId!,
              ctx,
              label: "task outcome",
            });
            return [
              ctx.mod.if(
                matchesBox,
                ctx.mod.block(null, [
                  encodeToBuffer(
                    packBoundaryValueAsMsgPack({
                      value: unboxOutcomeValue({
                        payload: ctx.mod.local.get(
                          payloadLocal,
                          binaryen.eqref,
                        ),
                        valueType: box.valueType,
                        typeId: box.typeId,
                        ctx,
                      }),
                      schema,
                      ctx,
                      fnCtx,
                    }),
                  ),
                  finishValue(),
                ]),
              ),
            ];
          } catch (error) {
            if (error instanceof BoundarySchemaError) {
              return [];
            }
            throw error;
          }
        }),
      ctx.mod.unreachable(),
    ];

    const branches = signatures.map((sig) => {
      const matches = ctx.mod.i32.eq(
        ctx.mod.local.get(opIndexLocal, binaryen.i32),
        ctx.mod.i32.const(sig.opIndex),
      );
      const msgpackMap = buildEffectRequestMsgPack({
        sig,
        request: () =>
          ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        msgPackType,
        msgpack,
        arrayLocal,
        ctx,
        runtime,
        fnCtx,
      });

      const effectOps = ctx.mod.block(null, [
        encodeToBuffer(msgpackMap),
        ctx.mod.return(
          runtime.makeEffectResult({
            status: ctx.mod.i32.const(EFFECT_RESULT_STATUS.effect),
            cont: ctx.mod.local.get(requestLocal, runtime.effectRequestType),
            payloadLen: ctx.mod.local.get(payloadLenLocal, binaryen.i32),
          }),
        ),
      ]);

      return ctx.mod.if(matches, effectOps);
    });

    const effectOps: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(
        requestLocal,
        refCast(
          ctx.mod,
          runtime.outcomePayload(
            ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
          ),
          runtime.effectRequestType,
        ),
      ),
      ctx.mod.local.set(
        opIndexLocal,
        runtime.requestOpIndex(
          ctx.mod.local.get(requestLocal, runtime.effectRequestType),
        ),
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
            runtime.outcomeTag(
              ctx.mod.local.get(outcomeLocal, runtime.outcomeType),
            ),
            ctx.mod.i32.const(EFFECT_RESULT_STATUS.value),
          ),
          ctx.mod.block(null, valueOps),
          ctx.mod.block(null, effectOps),
        ),
      ]),
    );

    ctx.mod.addFunctionExport(name, exportName);
    return name;
  });
